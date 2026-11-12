#!/bin/sh
# Test fixture for the request golden harness. Not a real plugin.
# Prints 6000000 bytes, over the 5 MiB subprocess stdout cap.
head -c 6000000 /dev/zero
