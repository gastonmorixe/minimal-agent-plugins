A lock error is final. The acquire path already retried with backoff for 30s, so do not re-call `Edit` at once. Wait a short time, or run `LockStatus`. If the lock stays, show the holder details to the user and ask before you proceed.

A file written with a shell command such as `sed -i` or `cat >` takes no lock and can race a peer. When concurrency matters, use `Edit` or `Write` instead of a shell write.
