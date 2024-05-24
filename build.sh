#!/bin/sh

ZTM_DIR=$(cd "$(dirname "$0")" && pwd)
ZTM_BIN="$ZTM_DIR/bin/ztm"

cd "$ZTM_DIR"
build/deps.sh

if [ $? -ne 0 ]; then
  exit 1
fi

cd "$ZTM_DIR"
build/gui.sh
build/pipy.sh

mkdir -p "$ZTM_DIR/bin"
rm -f "$ZTM_BIN"
cp -f "$ZTM_DIR/pipy/bin/pipy" "$ZTM_BIN"

echo "The final product is ready at $ZTM_BIN"
