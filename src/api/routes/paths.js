import express from 'express';
const paths_router = express.Router();
import db from '../config/DatabaseManager.js';


paths_router.use(express.json());

paths_router.get("/", async (req, res, next) => {
  return res.status(200).json({ code: 200``});
});


export default paths_router;
