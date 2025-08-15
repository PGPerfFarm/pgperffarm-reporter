#!/bin/sh

PGGITDIR="/usr/local/src/postgres"

for BRANCH in $(cd ${PGGITDIR} && git branch); do
	(cd ${PGGITDIR} && git checkout "${BRANCH}" && git pull -s)
done
