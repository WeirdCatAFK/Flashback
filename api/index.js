const express = require("express");
const app = express();
const morgan = require("morgan");

const config = require("./routes/config");

app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res, next) => {
  res.status(200);
  return res.send("Welcome to flashback");
});

app.use("/config", config);

app.use((req, res, next) => {
  return res.status(404).json({ code: 404, message: "Url no encontrada" });
});

app.listen(process.env.PORT || 50500, () => {
  console.log("Server is running on port 50500");
});
