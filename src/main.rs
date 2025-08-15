use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

use regex::Regex;

use actix_files::{Files, NamedFile};
use actix_web::{get, web, App, HttpRequest, HttpResponse, HttpServer, Result};

use chrono::{TimeZone, Utc};

use serde::{Deserialize, Serialize};

use tokio_postgres::NoTls;

use tera::{Context, Tera};

#[derive(Deserialize)]
struct AppConfig {
    buildbot_url: String,
    listen_address: String,
    postgres_conninfo: String,
    postgres_commit_url: String,
    postgres_path: String,
    port: u16,
}

#[derive(Clone)]
struct AppState {
    buildbot_url: String,
    postgres_conninfo: String,
    postgres_commit_url: String,
    postgres_path: String,
    tera: Tera,
}

#[derive(Serialize)]
struct Plant {
    name: String,
    admin: String,
    host: String,
    results: i64,
}

#[derive(Serialize)]
struct ResultsByTime {
    sorted: BTreeMap<i64, TestResult>,
    reversed: Vec<TestResult>,
}

#[derive(Serialize)]
struct TestResult {
    build_number: i32,
    builder_id: i32,
    ctime: i64,
    metric: String,
    revision: String,
    scale: u32,
    timestamp: String,
}

#[derive(Deserialize)]
struct WorkerInfo {
    admin: String,
    host: String,
}

type ResultsByScale = BTreeMap<u32, ResultsByBranch>;
type ResultsByBranch = BTreeMap<String, ResultsByTime>;

#[get("/")]
async fn home(req: HttpRequest) -> actix_web::Result<NamedFile> {
    let path = PathBuf::from([".", req.path(), "static/index.html"].join(""));
    Ok(NamedFile::open(path)?)
}

#[get("/pf/{test}")]
async fn pf_test(data: web::Data<AppState>, path: web::Path<String>) -> Result<HttpResponse> {
    let (client, connection) = tokio_postgres::connect(data.postgres_conninfo.as_str(), NoTls)
        .await
        .map_err(|e| {
            eprintln!("Failed to connect to the database: {}", e);
            actix_web::error::ErrorInternalServerError("Database connection error")
        })?;

    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("connection error: {}", e);
        }
    });

    let test: String = path.into_inner();

    let rows = client
        .query(
            "SELECT workers.name AS plant, info, count(*) AS results
FROM builders
   , builds
   , workers
WHERE builderid = builders.id
  AND workerid = workers.id
  AND builders.name = $1
  AND builds.results = 0
GROUP BY workers.name, info
ORDER BY workers.name",
            &[&test],
        )
        .await
        .map_err(|e| {
            eprintln!("Failed to query: {}", e);
            actix_web::error::ErrorInternalServerError("Query execution error")
        })?;

    let mut plants: Vec<Plant> = Vec::new();
    for row in rows {
        let worker: WorkerInfo = serde_json::from_str(row.get("info")).unwrap();
        let plant = Plant {
            name: row.get("plant"),
            admin: worker.admin.trim().to_string(),
            host: worker.host.trim().to_string(),
            results: row.get("results"),
        };
        plants.push(plant);
    }

    let mut context = Context::new();
    context.insert("test", &test);
    context.insert("plants", &plants);

    context.insert("title", &test_title(test.as_str()));

    let rendered = data.tera.render("test.html.tera", &context).unwrap();
    Ok(HttpResponse::Ok().content_type("text/html").body(rendered))
}

#[get("pf/{test}/{plant}")]
async fn pf_test_plant(
    data: web::Data<AppState>,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse> {
    let (client, connection) = tokio_postgres::connect(data.postgres_conninfo.as_str(), NoTls)
        .await
        .map_err(|e| {
            eprintln!("Failed to connect to the database: {}", e);
            actix_web::error::ErrorInternalServerError("Database connection error")
        })?;

    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("connection error: {}", e);
        }
    });

    let (test, plant): (String, String) = path.into_inner();
    let mut test2: String = test.clone();
    test2.push_str("-%");

    let rows = client
        .query(
            "WITH data AS (
    SELECT coalesce(btrim(branch.value, '\"'), '') AS branch
         , coalesce(
               btrim(revision.value, '\"')
             , btrim(got_revision.value, '\"')
           ) AS revision
         , coalesce(btrim(scale.value, '\"'), '0') AS scale
         , builderid AS builder_id
         , builds.number AS build_number
         , log_summary.id AS log_summary_id
         , coalesce(log_test1.id, log_test2.id) AS log_test_id
         , builds.complete_at
         , row_number() OVER (
               PARTITION BY workers.name
                          , branch.value
                          , revision.value
                          , scale.value
               ORDER BY builds.complete_at DESC
           ) AS latest
    FROM workers
         JOIN builds
           ON builds.workerid = workers.id
          AND builds.results = 0
         JOIN builders
           ON builderid = builders.id
          AND (
                  builders.name = $1
               OR builders.name LIKE $2
              )
         LEFT OUTER JOIN build_properties AS branch
           ON branch.buildid = builds.id
          AND branch.name = 'branch'
          AND branch.value <> '\"\"'
         LEFT OUTER JOIN build_properties AS revision
           ON revision.buildid = builds.id
          AND revision.name = 'revision'
          AND revision.value <> '\"\"'
         LEFT OUTER JOIN build_properties AS got_revision
           ON got_revision.buildid = builds.id
          AND got_revision.name = 'got_revision'
         LEFT OUTER JOIN build_properties AS scale
           ON scale.buildid = builds.id
          AND scale.name = 'warehouses'
         LEFT OUTER JOIN steps AS step_summary
           ON step_summary.buildid = builds.id
          AND step_summary.name = $4
         LEFT OUTER JOIN logs AS log_summary
           ON log_summary.stepid = step_summary.id
         LEFT OUTER JOIN steps AS step_test1
           ON step_test1.buildid = builds.id
          AND step_test1.name = 'Performance test'
         LEFT OUTER JOIN logs AS log_test1
           ON log_test1.stepid = step_test1.id
         LEFT OUTER JOIN steps AS step_test2
           ON step_test2.buildid = builds.id
          AND step_test2.name = 'Performance test (force)'
         LEFT OUTER JOIN logs AS log_test2
           ON log_test2.stepid = step_test2.id
    WHERE workers.name = $3
    ORDER BY builds.complete_at DESC
)
SELECT branch
     , revision
     , scale
     , builder_id
     , build_number
     , log_summary_id
     , log_test_id
FROM data
WHERE latest = 1
ORDER BY complete_at DESC",
            &[&test, &test2, &plant, &test_summary(test.as_str())],
        )
        .await
        .map_err(|e| {
            eprintln!("Failed to query: {}", e);
            actix_web::error::ErrorInternalServerError("Query execution error")
        })?;

    let mut context = Context::new();
    context.insert("test", &test);
    context.insert("plant", &plant);

    let mut results_by_scale: ResultsByScale = BTreeMap::new();

    for row in rows {
        let branch: String = row.get("branch");
        if branch.is_empty() {
            continue;
        }

        let output = Command::new("git")
            .arg("show")
            .arg("-s")
            .arg("--format=\"%ct\"")
            .arg::<String>(row.get("revision"))
            .current_dir(data.postgres_path.as_str())
            .output()
            .expect("could not run git to get commit ctime");

        if !output.status.success() {
            let revision: String = row.get("revision");
            eprintln!(
                "failed to run git show on {} {}: {}",
                branch,
                revision,
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let ctime = match std::str::from_utf8(&output.stdout)
            .expect("could not read git show output")
            .trim()
            .trim_matches('"')
            .to_string()
            .parse::<i64>()
        {
            Ok(ctime) => ctime,
            Err(e) => {
                let revision: String = row.get("revision");
                println!("error branch {} revision {}: {}", branch, revision, e);
                continue;
            }
        };

        let timestamp = Utc
            .timestamp_opt(ctime, 0)
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();

        let build_number: i32 = row.get("build_number");
        let builder_id: i32 = row.get("builder_id");
        let log_summary_id: i32 = row.get("log_summary_id");

        let scale_str: String = row.get("scale");
        let scale = if scale_str == "0" {
            let log_test_id: i32 = row.get("log_test_id");
            let raw_id = match test.as_str() {
                "dbt2" => log_test_id,
                "dbt3" => log_test_id,
                _ => log_summary_id,
            };
            test_scale(&data, test.as_str(), raw_id)
        } else {
            scale_str.parse::<u32>().unwrap()
        };

        let revision: String = row.get("revision");

        let test_result = TestResult {
            build_number,
            builder_id,
            ctime,
            metric: format!("{:.2}", test_metric(&data, test.as_str(), log_summary_id)),
            revision: revision[..8].to_string(),
            scale,
            timestamp: timestamp.clone(),
        };

        if let std::collections::btree_map::Entry::Vacant(e) = results_by_scale.entry(scale) {
            // First result at this scale.
            let mut results_by_time = ResultsByTime {
                sorted: BTreeMap::new(),
                reversed: Vec::new(),
            };
            results_by_time.sorted.insert(ctime, test_result);

            let mut results_by_branch: ResultsByBranch = BTreeMap::new();
            results_by_branch.insert(branch, results_by_time);

            e.insert(results_by_branch);
        } else if let std::collections::btree_map::Entry::Vacant(e) = results_by_scale
            .get_mut(&scale)
            .unwrap()
            .entry(branch.clone())
        {
            // First result from this branch.
            let mut results_by_time = ResultsByTime {
                sorted: BTreeMap::new(),
                reversed: Vec::new(),
            };
            results_by_time.sorted.insert(ctime, test_result);

            e.insert(results_by_time);
        } else {
            // Append the new result to existing branch and scale.
            let results_by_branch = results_by_scale
                .get_mut(&scale)
                .unwrap()
                .get_mut(&branch)
                .unwrap();
            results_by_branch.sorted.insert(ctime, test_result);
        }
    }

    for results_by_branch in results_by_scale.values_mut() {
        for results in results_by_branch.values_mut() {
            for (ctime, result) in results.sorted.range(..).rev() {
                let r2 = TestResult {
                    build_number: result.build_number,
                    builder_id: result.builder_id,
                    ctime: *ctime,
                    metric: result.metric.clone(),
                    revision: result.revision.clone(),
                    scale: result.scale,
                    timestamp: result.timestamp.clone(),
                };
                results.reversed.push(r2);
            }
        }
    }

    context.insert("buildbot_url", &data.buildbot_url.as_str());
    context.insert("postgres_commit_url", &data.postgres_commit_url.as_str());
    context.insert("scales", &results_by_scale);
    context.insert("metric_name", &test_metric_name(test.as_str()));
    context.insert("title", &test_title(test.as_str()));
    context.insert("unit", &scale_factor_unit(test.as_str()));

    let rendered = data.tera.render("test_plant.html.tera", &context).unwrap();
    Ok(HttpResponse::Ok().content_type("text/html").body(rendered))
}

fn scale_factor_unit(test: &str) -> String {
    match test {
        "dbt2" => String::from("Warehouses"),
        "dbt3" => String::from("Scale Factor"),
        "dbt5" => String::from("Customers"),
        "dbt7" => String::from("Scale Factor"),
        _ => String::from("Unknown"),
    }
}

fn test_metric(data: &AppState, test: &str, log_summary_id: i32) -> f64 {
    let mut url = data.buildbot_url.clone();
    url.push_str("/api/v2/logs/");
    url.push_str(log_summary_id.to_string().as_str());
    url.push_str("/raw_inline");

    let output = Command::new("curl")
        .arg("--silent")
        .arg(url)
        .output()
        .expect("could not run curl");

    let summary: String = std::str::from_utf8(&output.stdout)
        .expect("could not read curl output")
        .to_string();

    let metric_re = test_metric_re(test);
    let caps = metric_re.captures(summary.as_str()).unwrap();
    caps.get(1)
        .unwrap()
        .as_str()
        .to_string()
        .parse::<f64>()
        .unwrap()
}

fn test_metric_name(test: &str) -> String {
    match test {
        "dbt2" => String::from("New Orders per Minute"),
        "dbt3" => String::from("Queries per Hour"),
        "dbt5" => String::from("Trade Results per Second"),
        "dbt7" => String::from("Queries per Hour"),
        _ => String::from("Unknown"),
    }
}

fn test_metric_re(test: &str) -> Regex {
    match test {
        "dbt2" => Regex::new(r"Throughput: ([0-9]+.[0-9]+)").unwrap(),
        "dbt3" => Regex::new(r"Composite Score: +([0-9]+.[0-9]+)").unwrap(),
        "dbt5" => Regex::new(r"Reported Throughput: +([0-9]+.[0-9]+)").unwrap(),
        "dbt7" => Regex::new(r"Queries per Hour: ([0-9]+.[0-9]+)").unwrap(),
        _ => Regex::new("").unwrap(),
    }
}

fn test_summary(test: &str) -> String {
    match test {
        "dbt2" => String::from("DBT-2 Summary"),
        "dbt3" => String::from("DBT-3 Metrics"),
        "dbt5" => String::from("DBT-5 Summary"),
        "dbt7" => String::from("DBT-7 Summary"),
        _ => String::from("Unknown"),
    }
}

fn test_scale(data: &AppState, test: &str, raw_id: i32) -> u32 {
    let scale_re = test_scale_re(test);

    let mut url = data.buildbot_url.clone();
    url.push_str("/api/v2/logs/");
    url.push_str(raw_id.to_string().as_str());
    url.push_str("/raw_inline");
    let output = Command::new("curl")
        .arg("--silent")
        .arg(url)
        .output()
        .expect("could not run curl");

    let summary: String = std::str::from_utf8(&output.stdout)
        .expect("could not read curl output")
        .to_string();

    let caps = scale_re.captures(summary.as_str()).unwrap();
    caps.get(1)
        .unwrap()
        .as_str()
        .to_string()
        .parse::<u32>()
        .unwrap()
}

fn test_scale_re(test: &str) -> Regex {
    match test {
        "dbt2" => Regex::new(r"SCALE FACTOR \(WAREHOUSES\): ([0-9]+)").unwrap(),
        "dbt3" => Regex::new(r"SCALE: ([0-9]+)").unwrap(),
        "dbt5" => Regex::new(r"Configured Customers: +([0-9]+)").unwrap(),
        "dbt7" => Regex::new(r"Scale: +([0-9]+)").unwrap(),
        _ => Regex::new("").unwrap(),
    }
}

fn test_title(test: &str) -> String {
    match test {
        "dbt2" => String::from("Database Test 2"),
        "dbt3" => String::from("Database Test 3"),
        "dbt5" => String::from("Database Test 5"),
        "dbt7" => String::from("Database Test 7"),
        _ => String::from("Unknown"),
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let config = fs::read_to_string("config.json").expect("config.json not found");
    let app_config: AppConfig = serde_json::from_str(&config).expect("could not parse config");

    let data = AppState {
        buildbot_url: app_config.buildbot_url,
        postgres_commit_url: app_config.postgres_commit_url,
        postgres_conninfo: app_config.postgres_conninfo,
        postgres_path: app_config.postgres_path,
        tera: Tera::new("templates/**/*").unwrap(),
    };

    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(data.clone()))
            .service(home)
            .service(pf_test)
            .service(pf_test_plant)
            .service(Files::new("/static", "static"))
    })
    .bind((app_config.listen_address, app_config.port))?
    .run()
    .await
}
