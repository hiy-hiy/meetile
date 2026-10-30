const fc = require('fast-check');
const options = { numRuns: 300 };
if (process.env.FC_SEED !== undefined) {
  const seed = Number(process.env.FC_SEED);
  if (!Number.isInteger(seed)) throw new Error('FC_SEED must be an integer');
  options.seed = seed;
}
if (process.env.FC_PATH !== undefined) options.path = process.env.FC_PATH;
fc.configureGlobal(options);
