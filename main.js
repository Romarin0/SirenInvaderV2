const fs = require('fs');
const os = require('os');
const pm2 = require('pm2');
const performance = require('perf_hooks')
const csv_to_table = require('./csv');
const mongodb = require("./database/db");

const PATH = './StockEtablissement.csv';

const WORK_IN_PROGRESS = {};
const QUEUED_WORK = [];
const FREE_INSTANCES = [];
var FILTER = [];
const CPUS = os.cpus().length;
const NUM_OF_NODES = 1;
const startTime = performance.performance.now();

function UpdateWorkers(packet = null) {
    if (packet !== null) {
        if (packet.data.READY) {
            FREE_INSTANCES.push(packet.data.PID);
            console.log("Machine ready: " + packet.data.PID);
        } else {
            // worker finished something
            FREE_INSTANCES.push(packet.data.PID);
            const delay = performance.performance.now() - WORK_IN_PROGRESS[packet.data.FILE];
            console.log("Took " + delay + " ms for " + packet.data.FILE);
            console.log(FREE_INSTANCES.length + " free instances.");
            const totalTimeTaken = performance.performance.now() - startTime;
            console.log("Total time taken: " + totalTimeTaken/60000 + " mins");
            if(FREE_INSTANCES.length === CPUS * NUM_OF_NODES){
                console.log("Data loaded successfully to the db. Press Crtl+C to exit and 'pm2 delete all' to kill all processes");
            }
        }
    }

    if (QUEUED_WORK.length > 0 && FREE_INSTANCES.length > 0 && FILTER.length > 0) {
        let instanceReadyCount = Math.min(QUEUED_WORK.length, FREE_INSTANCES.length);

        for (let i = 0; i < instanceReadyCount; ++i) {
            const PID = FREE_INSTANCES[i];

            // Remove it from the FREE list
            FREE_INSTANCES.splice(i, 1);

            i -= 1;
            instanceReadyCount -= 1;

            const work = QUEUED_WORK.shift();

            WORK_IN_PROGRESS[work] = performance.performance.now();
            console.log("Sending work to " + PID + ": " + work);

            // Send it the work it will handle
            pm2.sendDataToProcessId(PID, {
                type: 'process:msg',
                data: {
                    FILE: work,
                    FILTER: FILTER
                },
                topic: "SIRENE-INVADER"
            }, (error, result) => {
                if (error) console.error(error);
            });
        }
    }
}

async function StartCluster() {
    await mongodb.createConnection(true);
    for (let i = 0; i < NUM_OF_NODES ; i++) {
        pm2.start({
            script: 'worker.js',
            name: `worker${i}`,
            instances: "max",
            out_file: "./logs/workerlog.log",
            error_file: "./logs/error.log"
        }, (err, _) => {
            if (err) console.error(err);
        });
    }
}

function FilterHeaders(header) {
    let csv = csv_to_table(header);
    let res = [];

    if (csv.length != 1) throw "Header doesn't exist.";

    let table_header = csv[0];

    const headers = [
        "siren",
        "nic",
        "siret",
        "dateCreationEtablissement",
        "dateDernierTraitementEtablissement",
        "typeVoieEtablissement",
        "libelleVoieEtablissement",
        "codePostalEtablissement",
        "libelleCommuneEtablissement",
        "codeCommuneEtablissement",
        "dateDebut",
        "etatAdministratifEtablissement"
    ];

    for (let i = 0; i < headers.length; ++i) {
        let idx = table_header.find(element => element.indexOf(headers[i]) > -1)
        if (idx === undefined) throw "Header not found: " + headers[i];
        res.push(idx);
    }

    return res;
}

async function SaveCSV(buffer, start, end, savePath) {
    await fs.writeFileSync(savePath, buffer.slice(start, end));
    QUEUED_WORK.push(savePath);
    UpdateWorkers();
}

function FindFirstCharacter(character, buffer, bufferSize) {
    for (let i = 0; i < bufferSize; ++i) {
        if (String.fromCharCode(buffer[i]) === character) {
            return i;
        }
    }
    return -1;
}

function FindLastCharacter(character, buffer, bufferSize) {
    for (let i = bufferSize - 1; i >= 0; --i) {
        if (String.fromCharCode(buffer[i]) === character) {
            return i;
        }
    }
    return -1;
}

async function SplitCSV() {
    const splitSizeInMB = 10;
    const chunkSize = 1024 * 1024 * splitSizeInMB;
    const chunkBuffer = Buffer.alloc(chunkSize);

    let bytesRead = 0;
    let offset = 0;
    let csvId = 0;
    let filter = null;

    const fp = fs.openSync(PATH, 'r');

    while (bytesRead = fs.readSync(fp, chunkBuffer, 0, chunkSize, offset)) {

        let streamEnd = FindLastCharacter("\n", chunkBuffer, bytesRead);
        let streamStart = 0; // Will be used to skip header

        if (streamEnd < 0) {
            throw "The buffer is too small or the file isn't an CSV.";
        } else {
            offset += streamEnd + 1;
        }

        // For the first pass, read the header & assign the filter
        if (FILTER.length == 0) {
            streamStart = FindFirstCharacter("\n", chunkBuffer, bytesRead);
            FILTER = FilterHeaders(chunkBuffer.slice(0, streamStart++).toString());
        }

        await SaveCSV(chunkBuffer, streamStart, streamEnd, `./data/generated/CSV-${csvId++}.csv`);

        //if (csvId > 50) break; // FOR DEBUGGING
    }

    console.log("Finished splitting CSV into " + csvId + " files.");
}

pm2.connect(async function (err) {
    if (err) {
        console.error(err)
        process.exit(2)
    }

    pm2.launchBus(function (err, pm2_bus) {
        pm2_bus.on('process:msg', function (packet) {
            console.log(packet);
            UpdateWorkers(packet);
        })
    });

    try {
        if (fs.existsSync(PATH)) {
            StartCluster();
            SplitCSV();
        } else {
            console.error(`File doesn't exist: ${PATH}`);
        }
    } catch (err) {
        console.error(err)
    }
});
