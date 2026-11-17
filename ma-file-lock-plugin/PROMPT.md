A lock error is final. Before the error, the harness tried again to get the lock at short intervals for 30 seconds. Thus do not use `Edit` again immediately. Wait a short time, or run `LockStatus`. If the lock stays, show the data of the session that has the lock to the user. Then ask the user before you continue.

A shell command that writes a file, for example `sed -i` or `cat >`, gets no lock. Thus it can write the file at the same time as a peer. When a peer can write the same file, use `Edit` or `Write`, not a shell command.
