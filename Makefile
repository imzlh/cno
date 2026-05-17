# Cross-platform Node.js polyfill builder
# Uses cts compile.js directly — no Node.js dependency

.PHONY: all clean

all:
	cts compile.js --all

clean:
	cts compile.js --all --clean
