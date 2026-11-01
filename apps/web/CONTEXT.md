# Pi Web

Pi Web hosts coding-agent sessions for user-selected projects while keeping the web server's runtime concerns separate from project work.

## Language

**Host Runtime Environment**:
The environment owned by the Pi Web server and its framework runtime.
_Avoid_: Project environment, shell environment

**Project Command Environment**:
The environment presented to a command that Pi Web runs on behalf of a user-selected project.
_Avoid_: Host environment, inherited environment

**Built-in Project Shell**:
A shell entry point owned and operated by Pi Web for commands it runs directly for the user (the composer's `!` and `!!`); the model's `bash` tool is pi's own core built-in, not a Pi Web shell.
_Avoid_: Extension shell, arbitrary child process
