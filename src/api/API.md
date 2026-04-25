# Flashback API

The Flashback API provides the core logic for the memorization workspace, including file system orchestration and data persistence.

## Validation & Initialization

Before the API starts, it undergoes a mandatory validation process to ensure the runtime environment and database are in a healthy state. 

**Critical Step**: For details on how the environment and database are validated or repaired at startup, please consult the [Validation Guide](./config/validators/VALIDATION.md).

## Core Responsibilities
- **Orchestration**: Synchronizes canonical `.flashback` files with the derived SQLite database.
- **SRS Engine**: Manages the Spaced Repetition logic and mastery propagation.
- **File Management**: Handles secure file operations within the workspace root.
