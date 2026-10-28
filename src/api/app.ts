import express from "express";
import jobRouter from "./routes/job.js";
import healthRouter from "./routes/health.js";

const app = express();
app.use(express.json());

app.use("/jobs", jobRouter);
app.use("/health", healthRouter);

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "Distributed Job Processor" });
});

export default app;
