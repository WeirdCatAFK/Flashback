const express = require("express");
const app = express();
const morgan = require("morgan");
const integrityCheck = require("./config/integrityManager");
const cors = "./config/cors";

app.use(cors);
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

async function startApp() {
  const configIsUsable = await integrityCheck.checkConfigIntegrity();

  if (!configIsUsable) {
    console.error("Configuration files are not usable. Exiting application.");
    process.exit(1);
  }

  //Loading modules here to ensure integrity before loading anything else that uses the config
  const config = require("./routes/config");
  const files = require("./routes/files");
  const upload = require("./routes/upload");
  const paths = require("./routes/paths");
  const tags = require("./routes/tags");
  const nodes = require("./routes/nodes");

  app.get("/", (req, res, next) => {
    res.status(200);
    return res.send("Welcome to flashback");
  });

  app.use("/config", config);

  app.use("/files", files);

  app.use("/upload", upload);

  app.use("/paths", paths);

  app.use("/tags", tags);

  app.use("/nodes", nodes);

  app.use((req, res, next) => {
    return res.status(404).json({ code: 404, message: "Url no encontrada" });
  });

  app.listen(process.env.PORT || 50500, () => {
    console.log("Server is running on port 50500");
  });
}

startApp();
