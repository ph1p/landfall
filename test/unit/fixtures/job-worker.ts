import fs from "node:fs";
import { startJob } from "../../../src/core/job";
import { JOB_INPUT, readJobInput } from "../../../src/core/job-input";

if (process.argv[2] === JOB_INPUT) {
  console.log(JSON.stringify({ actual: process.argv.slice(2), received: await readJobInput() }));
} else {
  const args: string[] = JSON.parse(fs.readFileSync(0, "utf8"));
  const job = startJob(args, () => {
    if (job.code === undefined) return;
    console.log(JSON.stringify({ code: job.code, lines: job.lines }));
  });
}
