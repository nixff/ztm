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

if [ -z "$BUILD_ZTM_SHARED" ]
then
  mkdir -p "$ZTM_DIR/bin"
  rm -f "$ZTM_BIN"
  cp -f "$ZTM_DIR/pipy/bin/pipy" "$ZTM_BIN"

  echo "The final product is ready at $ZTM_BIN"
else
  echo "The libztm.so is ready at $ZTM_DIR/usr/local/lib/libztm.so"
fi

if [ -n "$PACKAGE_OUTPUT" ]
then
  if [ -z "$BUILD_PIPY_SHARED" ]
  then
    # Package
    if [ ! -f version.env ]
    then
      echo "Missing version info, skip package..."
      exit 0
    fi

    bin/ztm version

    source version.env
    tar zcvf ztm-cli-${VERSION}-${OS_NAME}-${OS_ARCH}.tar.gz bin/ztm
  else
    tar zcvf libztm-${VERSION}.tar.gz usr/local/lib/*.so
     
  fi
fi
