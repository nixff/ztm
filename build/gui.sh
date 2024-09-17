#!/bin/bash

ZTM_DIR=$(cd "$(dirname "$0")" && cd .. && pwd)

cd "$ZTM_DIR/gui"
npm run build
npm run build:apps

rm -f "$ZTM_DIR/pipy/build/deps/codebases.tar.gz.h"
