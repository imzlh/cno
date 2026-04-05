# Build node polyfill, and install it to ~/.cno/node/

JSC ?= cts
DST_DIR = $(HOME)/.cts/node
SRC_DIR = src/node


.SILENT:

SRCS = $(shell find $(SRC_DIR) -name "*.ts" -type f 2>/dev/null)
OBJS = $(patsubst $(SRC_DIR)/%.ts,$(DST_DIR)/%.ts.jsc,$(SRCS))

.PHONY: all clean

all: $(DST_DIR) $(OBJS)

$(DST_DIR):
	mkdir -p $@

$(DST_DIR)/%.ts.jsc: $(SRC_DIR)/%.ts
	@mkdir -p $(dir $@)
	cp $< $(DST_DIR)/$*.ts
	$(JSC) compile.js $(SRC_DIR)/$*.ts node:$* $(DST_DIR)/$*.ts.jsc

clean:
	rm -rf $(DST_DIR)