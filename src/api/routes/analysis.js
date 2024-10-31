import express from 'express';
const analysis_router = express.Router();
import db from './../config/dbmanager.js';


analysis_router.use(express.json());

analysis_router.get("/", async (req, res, next) => {
  return res.status(200).json({ code: 200});
});


export default analysis_router;
