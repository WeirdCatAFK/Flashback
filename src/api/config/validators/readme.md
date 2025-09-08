# The validators folder

Each of these files is called by the validate.js before starting the api on electrons main process.

Each file returns a truthy value if in means of operation.

Each file (if necessary) makes an effort to load defaults if config or db data is not found.

Data is sensitive to the environment is run, node.js data will not be in the same spot as electron's runtime
