#!/bin/bash

ZTM_DIR=$(cd "$(dirname "$0")" && pwd)
ZTM_BIN="$ZTM_DIR/bin/ztm"

if [[ "$OSTYPE" == "linux-gnu"* ]]; then
  export OS_NAME=generic_linux
elif [[ "$OSTYPE" == "darwin"* ]]; then
  export OS_NAME=macos
fi

export OS_ARCH=$(uname -m)
if [[ $OS_ARCH == "aarch64" ]]
then
  export OS_ARCH=arm64
fi

cd "$ZTM_DIR"
build/deps.sh

if [ $? -ne 0 ]; then
  exit 1
fi

cd "$ZTM_DIR"
build/gui.sh
build/pipy.sh
