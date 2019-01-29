var Identity = Identity || {};
var Hubub = Hubub || {};

Identity.exec = require('child_process').exec;
Identity.requires = {};	// Holds all the requires...

Identity.getRequires = function (modules, i, callback) {
    if (i >= modules.length) {
        callback();
        return;
    }
    try {
        console.log('trying: ', modules[i]);
        Identity.requires[modules[i]] = require(modules[i]);
        Identity.getRequires(modules, i + 1, callback);
    } catch (err) {
        console.log('err: ', err);
        var cmd = "rm -rf node_modules/" + modules[i];	// remove the old version, if it was there at all...
        console.log("cmd: ", cmd);
        Identity.exec(cmd, function (error, stdout, stderr) {
            if (error != null) console.log("rm error: " + error);
            Identity.exec("npm install " + modules[i], function (error, stdout, stderr) {
                if (error != null) {
                    console.log('npm error: ', error);
                    Identity.getRequires(modules, i + 1, callback);	// skip...				
                }
                else {
                    Identity.getRequires(modules, i, callback);	// try again...									
                }
            });
        });
    }
};

//Get all modules and install if missing...
Identity.getRequires(["body-parser", "express", "heapdump",
    "ip", "macaddress", "nodemailer", "redis",
    "ursa", "xmlhttprequest"], 0, function () {
        //console.log("Here are the requires: ", Identity.requires);
        var fs = require('fs');
        require('heapdump');	// Send: kill -SIGUSR2 <pid> to generate a heapdump...

        // Set up static gets to allow this node to act as its own code server...
        var express = require('express');
        var app = express();
        //app.use('/public', express.static('public'));
        app.use(express.static('./IdentityKernel/IdentityPageBase'));
        app.use(express.static('../IdentityApp/IdentityPageBase'));
        app.use(express.static('../..'));


        eval(fs.readFileSync('./IdentityKernel/IdentityFoundation.js') + '');
        var codeController = new IdentityCodeController();
        codeController.retrieveCode(Identity.CloudParms.CodeURL, function () {
            //Identity.log("CodeController code: " +JSON.stringify(codeController.getCode()));
            var codeList = codeController.getLibs();
            for (var i = 0; i < codeList.length; i++) {
                Identity.currentLib = codeList[i].url;
                eval(codeList[i].code + '');
            }
            codeController.freeLibs();
            //eval(fs.readFileSync('./IdentitySystemLib.js')+'');

            codeList = codeController.getWebservices();
            for (var i = 0; i < codeList.length; i++) {
                Identity.currentLib = codeList[i].url;
                eval(codeList[i].code + '');
            }
            codeController.freeWebservices();

            //eval(fs.readFileSync('./IdentityServices/IdentityServices.js')+'');


            //new IdentityRedisDatabase();

            //		start databases serially, first Redis, then other databases can be started in startup tasks. 
            //		Must be done before Master or any of the workers to ensure dbs are available...
            Identity.startRedis(function () {

                Identity.log("Process.platform: " + process.platform);
                // Code to run if we're in the master process
                Identity.cpuCount = require('os').cpus().length;
                var maxCores = Identity.CloudParms.MaxCores;	// allow override of maxCores
                if (maxCores != undefined && maxCores < Identity.cpuCount) Identity.cpuCount = maxCores;
                if (cluster.isMaster) {
                    process.on('SIGINT', function () {
                        Identity.log(0, '\n************ shutting down ...');
                        //setTimeout(function() { Identity.log('\n************* quitting'); process.exit(0); }, 10000);
                        Identity.TaskScheduler.shutdown();
                    });

                    process.on('SIGTERM', function () {
                        Identity.log(0, '\n************ shutting down ...');
                        //etTimeout(function() { Identity.log('\n************* quitting'); process.exit(0); }, 4000);
                        Identity.TaskScheduler.shutdown();
                    });

                    Identity.WorkerParms.IdentityUniqueNodeInstance = "IdentityUnique-" + (new Date().getTime());
                    // Count the machine's CPUs
                    Identity.processInfo = "(ID: 0, PID: " + process.pid + ")";
                    Identity.processID = process.pid;
                    Identity.log("Master env: " + JSON.stringify(process.env));
                    //console.log("process.pid: " +process.pid);
                    Identity.log("cpuCount: " + Identity.cpuCount);

                    codeList = codeController.getMasterTasks();
                    for (var i = 0; i < codeList.length; i++) {
                        Identity.currentLib = codeList[i].url;
                        eval(codeList[i].code + '');
                    }
                    codeController.freeMasterTasks();

                    codeList = codeController.getWorkerTasks();	// Don't need them here, but do need to account for them in ReleaseManagement audit...
                    Identity.TaskScheduler.disableTaskRegistration(true);	// So don't actually register worker tasks to run in master...
                    for (var i = 0; i < codeList.length; i++) {
                        Identity.currentLib = codeList[i].url;
                        eval(codeList[i].code + '');
                    }
                    codeController.freeWorkerTasks();	// can free this one since it won't be used in Master process...

                    //eval(fs.readFileSync('IdentityTasks/tasks.js')+'');

                    // run all startup tasks before starting workers...
                    Identity.TaskScheduler.startup(function () {

                        // start worker(s) for each CPU
                        for (var i = 0; i < (Identity.cpuCount * Identity.CloudParms.WorkersPerCore); i++) {
                            cluster.fork(Identity.WorkerParms);
                        }

                        Identity.TaskScheduler.run();	// start timed background tasks...

                        // Listen for dying workers
                        cluster.on('exit', function (worker) {
                            //console.log("cluster.on(exit)...");
                            if (Identity.TaskScheduler.isShuttingdown()) {	// Don't replace worker if shutting down...
                                Identity.log(0, {
                                    file: false,
                                }, "Worker: " + worker.id + " is exiting...");
                                if (++Identity.workerShutdownCounter >= (Identity.cpuCount * Identity.CloudParms.WorkersPerCore)) {
                                    Identity.TaskScheduler.processTasks("shutdown", 0, function () {
                                        var exitCode = 0;
                                        if (Identity.isDocker == true) exitCode = 1;
                                        Identity.log(0, {
                                            file: false,
                                        }, "**** Master Exiting, exitCode: " + exitCode + " ...");
                                        process.exit(exitCode);
                                    });
                                }
                            }
                            else {
                                // Replace the dead worker, we're not sentimental
                                Identity.log('Worker ' + worker.id + ' died :(');
                                cluster.fork(Identity.WorkerParms);
                            }

                        });
                    });

                    //				Code to run if we're in a worker process
                } else {

                    process.on('SIGINT', function () {	// catch signals and let Master control shutdown...
                        Identity.log('\n************ Worker received SIGINT ...');
                    });
                    process.on('SIGTERM', function () {
                        Identity.log('\n************ Worker received SIGTERM ...');
                    });

                    Identity.processInfo = "(ID: " + cluster.worker.id + ", PID: " + cluster.worker.process.pid + ")";
                    //Identity.log("Worker process.env: " +JSON.stringify(process.env));
                    Identity.log(0, "Worker env.IdentityUniqueNodeInstance: " + JSON.stringify(process.env.IdentityUniqueNodeInstance));

                    codeList = codeController.getWorkerTasks();
                    for (var i = 0; i < codeList.length; i++) {
                        Identity.currentLib = codeList[i].url;
                        eval(codeList[i].code + '');
                    }
                    codeController.freeWorkerTasks();
                    codeController.freeMasterTasks();	// need to do this since they were loaded for all processes but not used for worker...

                    Identity.log("codeController.getCode(): " + JSON.stringify(codeController.getCode()));

                    //eval(fs.readFileSync('IdentityWorkerTasks/WorkerTasks.js')+'');

                    // run all startup tasks before starting this worker...
                    Identity.TaskScheduler.startup(function () {

                        Identity.TaskScheduler.run();	// start timed background tasks...
                        var isHttp = (Identity.CloudParms.ListenProtocol == 'http');
                        var http = null;
                        var https = null;
                        var privateKey = null;
                        var certificate = null;
                        var credentials = null;
                        if (isHttp) {
                            http = require('http');
                        }
                        else {
                            https = require('https');
                            privateKey = fs.readFileSync('../IdentityApp/ssl/' + Identity.CloudParms.SSLKeyFile, 'utf8');
                            certificate = fs.readFileSync('../IdentityApp/ssl/' + Identity.CloudParms.SSLCertFile, 'utf8');
                            credentials = { key: privateKey, cert: certificate };
                        }
                        var counter = 0;

                        var bodyParser = require('body-parser');
                        app.use(bodyParser.json());       // to support JSON-encoded bodies
                        app.use(function (error, req, res, next) {
                            Identity.log("Bad JUJU...");
                            console.error(error.stack);
                            //res.send("REALLY BAD JUJU...");
                            res.send("Error: " + error.message);
                        });
                        app.use(bodyParser.urlencoded({     // to support URL-encoded bodies
                            extended: true
                        }));



                        //					Set up CORS
                        app.use(function (req, res, next) {
                            res.header("Access-Control-Allow-Origin", "*");
                            res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
                            next();
                        });


                        //					respond with "Hello World!" on the homepage
                        app.get('/', function (req, res) {
                            res.send('Hello World!');
                        });

                        //					accept GET request at /user
                        app.get('/public', function (req, res) {
                            res.send("Got a GET request at /user<br>counter: " + (counter++) + ", req header user-agent: " + util.inspect(req.headers['user-agent']));
                        });

                        //					accept POST request on the homepage
                        app.post('/', function (req, res) {
                            //Identity.log("req.body: " +util.inspect(req.body));
                            var errors = false;
                            var idWS = null;
                            try {
                                idWS = new IdentityWS(req.body);
                            } catch (error) {
                                res.send("Error: " + error.message);
                                errors = true;
                            }
                            //Identity.log("idWS: " +JSON.stringify(idWS));
                            if (!errors) {
                                //dbHandles.rc = redisClient;
                                Identity.dispatcher(res, idWS, Identity.dbHandles);
                            }
                        });

                        //					accept PUT request at /user
                        app.put('/user', function (req, res) {
                            res.send('Got a PUT request at /user');
                        });

                        //					accept DELETE request at /user
                        //					app.delete('/user', function (req, res) {
                        //					res.send('Got a DELETE request at /user');
                        //					});
                        var httpServer = null;
                        if (isHttp) {
                            httpServer = http.createServer(app);
                        }
                        else {
                            httpServer = https.createServer(credentials, app);
                        }
                        var server = httpServer.listen(Identity.CloudParms.ListenPort, Identity.CloudParms.ListenHost, function () {
                            var host = server.address().address;
                            var port = server.address().port;

                            Identity.log(1, 'IdentityCloud listening at ' + Identity.CloudParms.ListenProtocol + '://%s:%s', host, port);
                        });


                    });

                };
            });
        });
    });

