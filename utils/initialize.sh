#!/bin/sh
echo "We will pull types from circu.js, please wait..."
git clone --filter=blob:none --sparse https://github.com/imzlh/circu.js
cd circu.js
git sparse-checkout set types
mv types ..
cd ..
rm -rf circu.js
echo "Done."