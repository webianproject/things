#!/bin/bash

# This script performs a rollback of a failed upgrade. It expects to be run in
# the ~/mozilla-iot directory where it can see gateway, gateway_old, and
# gateway_failed

# from https://stackoverflow.com/questions/552724/
function recentEnough() {
   local filename=$1
   local changed=`stat -c %Y "$filename"`
   local now=`date +%s`
   local elapsed

   let elapsed=now-changed
   # if less than 60 * 60 * 24 * 14 seconds have passed
   if [ $elapsed -lt 1209600 ]; then
     return 1
   else
     return 0
   fi
}

if [ -d "gateway_old" ] && [ ! -z `recentEnough "gateway_old"` ]; then
  if [ -d "gateway_failed" ]; then
    rm -fr gateway_failed
  fi
  mv gateway gateway_failed
  mv gateway_old gateway
fi
