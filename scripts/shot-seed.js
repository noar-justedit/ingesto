// Seeds the profile the screenshots are taken against: one saved job with two
// folder pairs, and a recent-jobs list that is not empty.
//
// Written with the application's own config module, into the same file the
// application reads, BEFORE it starts. Nothing is poked into a running window,
// so what the camera sees is a normal launch of a normal profile.
//
//   node scripts/shot-seed.js <userData-dir> <jobs-dir>

const fs   = require('fs');
const path = require('path');
const { Prefs, defaultJob, saveJob } = require('../src/main/config');

const userData = process.argv[2] || path.join(process.env.HOME, '.config', 'syncto');
const jobsDir  = process.argv[3] || path.join(process.env.HOME, 'syncto jobs');

fs.mkdirSync(jobsDir, { recursive: true });

const job = defaultJob();
job.name = 'PROJET TOSCANE — backup';
job.pairs = [
  { left: '/Volumes/CAM_A/DCIM',          right: '/Volumes/NAS_EDIT/PROJET_TOSCANE/01_RUSHES'  },
  { left: '/Volumes/SSD_MONTAGE/EXPORTS', right: '/Volumes/NAS_EDIT/PROJET_TOSCANE/05_EXPORTS' },
];
job.sync.variant           = 'mirror';
job.sync.deletion          = 'permanent';
job.sync.writeChecksumList = true;
job.compare.excludeFilter  = '*.tmp\n/Proxies/';

const file = path.join(jobsDir, 'PROJET TOSCANE.syncto');
saveJob(file, job);

const prefs = new Prefs(userData);
prefs.load();
prefs.data.job         = job;
prefs.data.lastJobPath = file;
prefs.data.recent      = [
  { name: job.name, path: file },
];
prefs.data.window = { width: 1440, height: 900 };
prefs.save();

console.log('seeded', prefs.file);
