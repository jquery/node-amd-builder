'use strict';

var express = require( 'express' ),
    app = express.createServer(),
    async = require( 'async'),
    crypto = require( 'crypto' ),
    fs = require( 'fs' ),
    rimraf = require( 'rimraf' ),
    exec = require( 'child_process' ).exec,
    path = require( 'path' ),
    regexp = require( './lib/regexp' ),
	requirejs = require( 'requirejs' ),
    requirejs_traceFiles = require( './lib/r.js' );

var httpPort = process.env.PORT || 8080,
    repoBaseDir = path.normalize( process.env.REPO_BASE_DIR ),
    workBaseDir = path.normalize ( process.env.WORK_BASE_DIR );

app.configure('development', function(){
    app.use( express.errorHandler({ dumpExceptions: true, showStack: true }) );
    app.use( express.logger( 'tiny' ) );
});

app.configure('production', function(){
});

app.use(express.bodyParser());

app.get( '/', function ( req, res ) {
    res.send( "<h1 style='text-align: center; font-size: 120px;'>ZOMG JQM-BUILDER</h1>" );
});

function fetch( repo, callback ) {
    exec( "git fetch",
        {
            encoding: 'utf8',
            timeout: 0,
            cwd: repo,
            env: null
        },
        callback
    );
}

function checkout( repoName, repoDir, tag, force, callback ){
    if ( typeof force === "function" ) {
        callback = force;
        force = false;
    }
    if (!repoName) throw new Error( "No repo name specified" );
    if (!repoDir) throw new Error( "No repo dir specified" );
    if (!callback) throw new Error( "No callback passed to checkout()" );
    if (!tag) {
        tag = "master";
    }

    // Workspace
    var wsDir  = workBaseDir + "/" + repoName + "." + tag;

    path.exists( wsDir, function( exists ) {
        if ( exists || force ) {
            fs.mkdir( wsDir, function () {
                exec( "git --work-tree=" + wsDir + " checkout -f " + tag,
                    {
                        encoding: 'utf8',
                        timeout: 0,
                        cwd: repoDir,
                        env: null
                    },
                    callback
                );
            });
        } else {
            callback( "Worspace for " + repoName + "/" + tag + " has not been created" );
        }
    });
}

function getFirstExistingDir( candidates, callback ) {
    var dir = candidates.shift();
    path.exists( dir , function( exists ) {
        if ( exists ) {
            callback( null, dir );
        } else {
            if ( candidates.length ) {
                getFirstExistingDir( candidates, callback );
            } else {
                callback( "none found" );
            }
        }
    });
}

function getRepoDir( repo, callback ) {
    var repoDir = repoBaseDir + "/" + repo;
    getFirstExistingDir( [ repoDir, repoDir + ".git" ], callback );
}

function getWorkspaceDirSync( repo, tag ) {
    return workBaseDir + "/" + repo + "." + tag;
}

function getCompiledDirSync( repo, tag ) {
    return getWorkspaceDirSync( repo, tag ) + "/__compiled";
}

app.get( '/:repo/fetch', function ( req, res ) {
    var repo = repoBaseDir + "/" + req.params.repo;

    fetch( repo,
        function ( error, stdout, stderr ) {
            //console.log('stdout: ' + stdout);
            //console.log('stderr: ' + stderr);
            if ( error !== null ) {
                res.send( error, 500 );
            } else {
                res.send( stdout );
            }
        }
    );
});

app.post( '/post_receive', function ( req, res ) {
    var payload = req.body.payload,
        repoName, repoDir, tag,
        fetchIfExists = function( candidates, callback ) {
            var dir = candidates.shift();
            path.exists( dir , function( exists ) {
                if ( exists ) {
                    fetch( dir,
                        function ( error, stdout, stderr ) {
                            if ( error !== null ) {
                                res.send( error, 500 );
                            } else {
                                callback( dir );
                            }
                        }
                    );
                } else {
                    if ( candidates.length ) {
                        fetchIfExists( candidates );
                    } else {
                        res.send( "Workspace for '" + repoName + "' hasn't been checked out", 404 );
                    }
                }
            });
        };

    if ( payload ) {
        try {
            payload = JSON.parse( payload );
            repoName = payload.repository.name;
            tag = payload.ref.split( "/" ).pop();

            if ( payload.repository && payload.repository.name ) {
                async.waterfall([
                    function( callback ){
                        getRepoDir( repoName, callback );
                    },
                    function( dir, callback ) {
                        repoDir = dir;
                        fetch( dir, callback );
                    },
                    function( stdout, stderr, callback ) {
                        checkout( repoName, repoDir, tag, callback );
                    },
                    function( stdout, stderr, callback ) {
                        var compiled = getCompiledDirSync( repoName, tag );
                        async.series([
                            function( cb ) {
                                rimraf( compiled, cb );
                            },
                            function( cb ) {
                                fs.mkdir( compiled, cb );
                            }

                        ], function( err, results ) {
                            if ( err )  {
                                callback( err );
                            } else {
                                callback( null, stdout );
                            }
                        });
                    }
                ],
                function ( err, result ) {
                    if ( err ) {
                        res.send( err, 500 );
                    } else {
                        res.send( "OK" );
                    }
                });
            } else {
                res.send( "Payload is missing data", 404 );
            }
        } catch( e ) {
            res.send( e, 500 );
        }
    } else {
        res.send( "No Payload!", 400 );
    }
});

app.get( '/:repo/:tag/checkout', function ( req, res ) {
    var repoName = req.params.repo,
        tag      = req.params.tag;

    async.waterfall([
        function( callback ) {
            getRepoDir( repoName, callback )
        },
        function( repoDir, callback ) {
            checkout( repoName, repoDir, tag, callback );
        },
        function( stdout, stderr, callback ) {
            res.send( stdout );
            callback( null );
        }

    ], function( err ) {
        if ( err ) {
            res.send( err, 500 );
        }
    });
});

app.get( '/:repo/:tag/make', function ( req, res ) {
    var include = req.param( "include", "main" ).split( "," ).sort(),
        exclude = req.param( "exclude", "" ).split( "," ).sort(),
        optimize = req.param( "optimize", "none" ),
        baseUrl = req.param( "baseUrl", "." ),
        pragmas = JSON.parse( req.param( "pragmas", "{}" ) ),
        pragmasOnSave = JSON.parse( req.param( "pragmasOnSave", "{}" ) ),
        name = path.basename( req.param( "name", req.params.repo ), ".js" ),
        shasum = crypto.createHash( 'sha1' ),
        wsDir   = getWorkspaceDirSync( req.params.repo, req.params.tag ),
        dstDir, dstFile;

	//Set up the config passed to the optimizer
	var config = {
		baseUrl: wsDir + "/" + baseUrl,
		include: include,
        pragmas: pragmas,
        pragmasOnSave: pragmasOnSave
	};

    shasum.update( JSON.stringify( config ) );

    dstDir = getCompiledDirSync( req.params.repo, req.params.tag ) + shasum.digest( 'hex' );
    dstFile = dstDir + "/" + name + (optimize !== "none" ? ".min" : "") + ".js";

    config.out = dstFile;
    config.optimize = optimize;

    path.exists( dstFile, function ( exists ) {
        if ( exists ) {
            res.download( dstFile, path.basename( dstFile ) );
        } else {
            try {
				requirejs.optimize( config, function ( buildResponse ) {
					//buildResponse is just a text output of the modules
					//included. Load the built file for the contents.
					fs.readFile( config.out, 'utf8', function( err, contents ) {
                        if ( err ) throw err;
						res.send( contents );
					});
				});
			} catch ( e ) {
				res.send( e.toString(), 500 );
			}
        }
    });
});

app.get( '/:repo/:tag/dependencies', function ( req, res ) {
    var wsDir = getWorkspaceDirSync( req.params.repo, req.params.tag ),
        names = req.param( "names", "" ).split( "," ).filter( function(name) {return !!name} ).sort(),
        exclude = req.param( "exclude", "" ).split( "," ).sort(),
        baseUrl = path.normalize( wsDir + "/" + req.param( "baseUrl", "." ) ),
        shasum = crypto.createHash( 'sha1' ),
        filename = getCompiledDirSync( req.params.repo, req.params.tag ) + "/deps-";

    async.series([
        function( callback ) {
            // If no name is provided, scan the baseUrl for js files and return the dep map for all JS objects in baseUrl
            if ( names.length ) {
                callback( null );
            } else {
                fs.readdir(baseUrl, function( err, files ) {
                    if ( err ) {
                        callback( err );
                    } else {
                        files = files.filter( function( file ) { return path.extname( file ) === ".js" } );
                        names = files.map( function( file ) { return path.basename( file, ".js" ) } );

                        callback( null );
                    }
                });
            }
        },
        function( callback ) {
            // Generate a sha on the sorted names
            shasum.update( names.join( "," ) );
            filename += shasum.digest( 'hex' ) + ".json";

            path.exists( filename,
                function( exists ) {
                    if ( exists ){
                        res.sendfile( filename );
                    } else {
                        requirejs_traceFiles.tools.traceFiles( {
                                baseUrl: baseUrl,
                                modules: names.map( function( name ) { return { name: name } } )
                            },
                            function( deps ) {
                                // Walk through the dep map and remove baseUrl and js extention
                                var module,
                                    baseUrlRE = new RegExp( "^" + regexp.escapeString( baseUrl + "/") ),
                                    jsExtRE = new RegExp( regexp.escapeString( ".js" ) + "$" );
                                for ( module in deps ) {
                                    deps[ module ].files.pop();
                                    deps[ module ].deps = deps[ module ].files.map(
                                        function( file ) {
                                            return file.replace( baseUrlRE, "" ).replace( jsExtRE, "" );
                                        }
                                    );
                                    delete deps[ module ].files;
                                }
                                fs.writeFile( filename, JSON.stringify( deps ),
                                    function (err) {
                                        if (err) throw err;
                                    }
                                );
                                res.json( deps );
                            }
                        );
                    }
                }
            )
        }
    ]);
});

console.log( "listening on port:", httpPort );
app.listen( httpPort );