import express from "express";
import jobRouter from "./routes/job.js";

const app = express();
app.use(express.json());

app.use("/jobs", jobRouter);

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: "Distributed Job Processor" });
});

export default app;
