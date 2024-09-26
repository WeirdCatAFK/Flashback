const express = require("express");
const app = express();
const morgan = require("morgan");

app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res, next) => {
  res.status(200);
  return res.send("Welcome to flashback");
});


app.listen(process.env.PORT || 3000, () => {
    console.log("Server is running on port 3000");
  });
  