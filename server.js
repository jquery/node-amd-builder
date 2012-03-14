'use strict';

var express = require( 'express' ),
    app = express.createServer(),
    async = require( 'async'),
    crypto = require( 'crypto' ),
    fs = require( 'fs' ),
    Git = require( './lib/git'),
    exec = require( 'child_process' ).exec,
    path = require( 'path' ),
    Promise = require( 'node-promise').Promise,
    regexp = require( './lib/regexp' ),
	requirejs = require( 'requirejs' ),
    rimraf = require( 'rimraf' );

var httpPort = process.env.PORT || 8080,
    repoBaseDir = path.normalize( process.env.REPO_BASE_DIR ),
    workBaseDir = path.normalize ( process.env.WORK_BASE_DIR ),
    filters = {},
    bundlePromises = {};

app.configure('development', function(){
    app.use( express.errorHandler({ dumpExceptions: true, showStack: true }) );
    app.use( express.logger( 'tiny' ) );
});

app.configure('production', function(){
});

app.use(express.bodyParser());

//function loadConfig() {
//    config = JSON.parse( fs.readFileSync( configFilename, 'utf8' ) );
//}
//
//loadConfig();
//fs.watchFile( configFilename, { persistent: true, interval: 500 }, loadConfig);

app.get( '/', function ( req, res ) {
    res.send( "<h1 style='text-align: center; font-size: 120px;'>ZOMG JQM-BUILDER</h1>" );
});

function fetch( repoDir, callback ) {
    Git( repoDir );
    Git.exec( [ "fetch" ], callback );
}

function cleanup( project, repo, ref, callback ) {
    var compiled = getCompiledDirSync( project, repo, ref );

    async.series([
        function( next ) {
            rimraf( compiled, next );
        },
        function( next ) {
            fs.mkdir( compiled, next );
        },
        function( next ) {
            var wsDir = getWorkspaceDirSync( project, repo, ref ),
                filterPath;
            for ( filterPath in filters[ wsDir ] ) {
                delete require.cache[ filterPath ];
                delete filters[ wsDir ][ filterPath ];
            }
            next( null );
        }
    ], function( err, results ) {
        if ( err )  {
            callback( err );
        } else {
            callback();
        }
    });

}

function checkout( project, repo, ref, force, callback ){
    if ( typeof force === "function" ) {
        callback = force;
        force = false;
    }

    // Workspace
    var workDir  = getWorkspaceDirSync( project, repo, ref );

    path.exists( workDir, function( exists ) {
        if ( exists || force ) {
            async.waterfall([
                function( next ) {
                    fs.mkdir( workDir, function( err ) {
                        if ( err && err.code != "EEXIST" ) {
                            next( err );
                        } else {
                            next( null );
                        }
                    });
                },
                function( next ) {
                    getRepoDir( project, repo, next )
                },
                function( dir, next ) {
                    Git( dir, workDir );
                    Git.exec( [ "checkout", "-f", ref ], next );
                },
                function( out, next ) {
                    cleanup( project, repo, ref, next );
                }
            ], function( err ) {
                if ( err ) {
                    callback( err );
                } else {
                    callback( null );
                }
            });
        } else {
            callback( "Worspace for " + repo + "/" + ref + " has not been created" );
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

function getProjectSpecificDirSync( baseDir, project ) {
    if ( project ) {
        baseDir = path.join( baseDir, project );
    }
    return baseDir;
}

function getRepoBaseDirSync( project ) {
    return getProjectSpecificDirSync( repoBaseDir, project );
}

function getWorkspaceBaseDirSync( project ) {
    return getProjectSpecificDirSync( workBaseDir, project );
}

function getRepoDir( project, repo, callback ) {
    var repoDir = path.join( getRepoBaseDirSync( project ), repo );
    getFirstExistingDir( [ repoDir, repoDir + ".git" ], callback );
}

function getWorkspaceDirSync( project, repo, ref ) {
    var workspaceDir;
    if ( project ) {
        workspaceDir = path.join( getWorkspaceBaseDirSync( project ), ref, repo )
    } else {
        path.join( repo, ref )
    }

    return workspaceDir;
}

function getCompiledDirSync( project, repo, ref ) {
    return path.join( getWorkspaceDirSync( project, repo, ref ), "__compiled" );
}

app.post( '/post_receive', function ( req, res ) {
    var payload = req.body.payload,
        project, repoName, repoUrl, ref,
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
            repoUrl = url.parse( payload.repository.url );
            project = path.dirname( repoUrl.path ).substring( 1 );
            ref = payload.ref.split( "/" ).pop();

            if ( project && repoName && ref ) {
                async.waterfall([
                    function( next ){
                        getRepoDir( project, repoName, next );
                    },
                    function( dir, next ) {
                        fetch( dir, next );
                    },
                    function( out, next ) {
                        checkout( project, repoName, ref, next );
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

app.get( '/v1/:project/:repo', function ( req, res ) {
    async.waterfall([
        function( callback ) {
            getRepoDir( req.params.project, req.params.repo, callback )
        },
        fetch,
        function ( out ) {
            res.send( (out?"\n":"") + "OK" );
        }
    ], function( err ) {
        if ( err ) {
            res.send( err, 500 );
        }
    })
});

app.get( '/v1/:project/:repo/:ref', function ( req, res ) {
    var project = req.params.project,
        repo    = req.params.repo,
        ref     = req.params.ref;

    checkout( project, repo, ref,
        function( err ) {
            if ( err ) {
                res.send( err, 500 );
            } else {
                res.send( "OK" );
            }
        }
    );
});

app.get( '/v1/bundle/:project/:repo/:ref/:name?', function ( req, res ) {
    var include = req.param( "include", "main" ).split( "," ).sort(),
        exclude = req.param( "exclude", "" ).split( "," ).sort(),
        optimize = req.param( "optimize", "none" ),
        baseUrl = req.param( "baseUrl", "." ),
        pragmas = JSON.parse( req.param( "pragmas", "{}" ) ),
        pragmasOnSave = JSON.parse( req.param( "pragmasOnSave", "{}" ) ),
        ext = (optimize !== "none" ? ".min" : "") + ".js",
        name = req.params.name || ( path.basename( req.params.repo, ".js" ) + ext ),
        filter = req.param( "filter" ),
        shasum = crypto.createHash( 'sha1' ),
        wsDir   = getWorkspaceDirSync( req.params.project, req.params.repo, req.params.ref ),
        dstDir, dstFile, digest;

    // var baseUrlFilters[baseUrl] = require(path.join(baseUrl, 'somemagicnameOrpackage.jsonEntry.js'));
	var config = {
		baseUrl: path.join( wsDir, baseUrl ),
		include: include,
        exclude: exclude,
        pragmas: pragmas,
        pragmasOnSave: pragmasOnSave
	};

    shasum.update( JSON.stringify( config ) );
    if ( filter ) {
        shasum.update( filter );
    }

    digest = shasum.digest( 'hex' );

    dstDir = getCompiledDirSync( req.params.project, req.params.repo, req.params.ref );
    dstFile = path.join( dstDir, digest + ext );

    config.out = dstFile;
    config.optimize = optimize;

    function buildBundle() {
        var promise = new Promise();
        path.exists( dstFile, function ( exists ) {
            if ( exists ) {
                promise.resolve( [ dstFile, name ] );
            } else {
                try {
    				requirejs.optimize( config, function ( buildResponse ) {
    					//buildResponse is just a text output of the modules
    					//included. Load the built file for the contents.
    					fs.readFile( config.out, 'utf8', function( err, contents ) {
                            if ( err ) throw err;
                            var filterPath = path.join( config.baseUrl, filter );
                            if ( filter ) {
                                filters[ wsDir ] = filters[ wsDir ] || {};
                                filters[ wsDir ][ filterPath ] = require( filterPath );
                                contents = filters[ wsDir ][ filterPath ]( contents );
                            }
                            fs.writeFile( config.out, contents, 'utf8',
                                function( err ) {
                                    if ( err ) throw err;
                                    promise.resolve( config.out, name );
                                }
                            );
    					});
    				});
    			} catch ( e ) {
                    promise.reject( e.toString() );
    			}
            }
        });
        return promise;
    }

    function onBundleBuildError( error ) {
        res.header( "Access-Control-Allow-Origin", "*");
        res.send( error, 500 );
        delete bundlePromises[ digest ];
    }

    function onBundleBuilt() {
        path.exists( dstFile, function ( exists ) {
            if ( exists ) {
                res.header( "Access-Control-Allow-Origin", "*");
                res.download( dstFile, name );
            } else {
                // Try to land back on our feet if for some reasons the built bundle got cleaned up;
                bundlePromises[ digest ] = buildBundle().then( onBundleBuilt, onBundleBuildError );
            }
        });
    }

    if ( !bundlePromises[ digest ] ) {
        bundlePromises[ digest ] = buildBundle();
    }

    bundlePromises[ digest ].then( onBundleBuilt, onBundleBuildError );
});

function buildDependencyMap( project, repo, ref, baseUrl, include ) {
    var promise = new Promise(),
        shasum = crypto.createHash( 'sha1' ),
        compileDir = getCompiledDirSync( project, repo, ref ),
        filename = compileDir + "/deps-";

    async.waterfall([
        function( next ) {
            // If no name is provided, scan the baseUrl for js files and return the dep map for all JS objects in baseUrl
            if ( include.length ) {
                next();
            } else {
                fs.readdir( baseUrl, function( err, files ) {
                    if ( err ) {
                        next( err );
                    } else {
                        files = files.filter( function( file ) { return path.extname( file ) === ".js" } );
                        include = files.map( function( file ) { return path.basename( file, ".js" ) } );
                        next();
                    }
                });
            }
        },
        function( next ) {
            // Generate a sha on the sorted names
            shasum.update( include.join( "," ) );
            filename += shasum.digest( 'hex' ) + ".json";

            path.exists( filename, function( exists ) {
                next( null, exists )
            });
        },
        function( exists, next ) {
            if ( exists ){
                fs.readFile( filename, "utf8", function( err, data ) {
                    if ( err ) {
                        promise.reject( err );
                    } else {
                        promise.resolve( JSON.parse( data ) );
                    }
                });
            } else {
                async.waterfall([
                    function( cb ) {
                        fs.mkdir( compileDir, function( err ) {
                            if ( err && err.code != "EEXIST" ) {
                                cb( err );
                            } else {
                                cb( null );
                            }
                        });
                    },
                    function( cb ) {
                        requirejs.tools.useLib( function ( require ) {
                            require( [ 'parse' ], function ( parse ) {
                                cb( null, parse );
                            })
                        });
                    },
                    function( parse, cb ) {
                        var deps = {};
                        async.forEach( include, function ( name, done ) {
                            var fileName = path.join( baseUrl, name + ".js" );
                            fs.readFile( fileName, 'utf8', function( err, data ) {
                                if ( err ) {
                                    callback( err );
                                }
                                deps[ name ] = {};
                                deps[ name ].deps = parse.findDependencies( fileName, data );
                                done();
                            });
                        }, function( err ) {
                            cb( err, deps );
                        });
                    },
                    function( deps, cb ) {
                        // Walk through the dep map and remove baseUrl and js extension
                        var module,
                            modules = [],
                            baseUrlRE = new RegExp( "^" + regexp.escapeString( baseUrl + "/") ),
                            jsExtRE = new RegExp( regexp.escapeString( ".js" ) + "$" );
                        for ( module in deps ) {
                            modules.push( module );
                        }

                        async.forEach( modules,
                            function( item, callback ) {
                                async.waterfall([
                                    function( next ) {
                                        fs.readFile( path.join( baseUrl, item+".js" ), 'utf8', next );
                                    },
                                    function( data, next ) {
                                        var attrMatchRE = /^.*\/\/>>\s*\w+\s*:.*$/mg,
                                            matches = data.match( attrMatchRE );
                                        if ( matches && matches.length ) {
                                            matches.forEach( function( meta ) {
                                                var attr = meta.replace( /^.*\/\/>>\s*(\w+)\s*:.*$/, "$1" );
                                                var attrLabelRE = new RegExp( "^.*" + regexp.escapeString( "//>>" + attr + ":") + "\\s*", "m" );
                                                deps[ item ][ attr ] = meta.replace( attrLabelRE, "" ).trim();
                                            });
                                        }
                                        next();
                                    }
                                ],
                                    function( err ){
                                        if ( err ) {
                                            promise.reject( err );
                                        } else {
                                            callback();
                                        }
                                    });
                            },
                            function( err ) {
                                if ( err ) {
                                    cb( err );
                                } else {
                                    cb( null, deps );
                                }
                            }
                        )
                    },
                    function( deps, cb ){
                        fs.writeFile( filename, JSON.stringify( deps ), "utf8",
                            function( err ) {
                                if ( !err ) {
                                    promise.resolve( deps );
                                }
                                cb( err );
                            }
                        );
                    }
                ],
                    function( err ) {
                        if ( err ) {
                            promise.reject( err );
                        }
                    })
            }
        }
    ]);
    return promise;
}

app.get( '/v1/dependencies/:project/:repo/:ref', function ( req, res ) {
    var wsDir = getWorkspaceDirSync( req.params.project, req.params.repo, req.params.ref ),
        names = req.param( "names", "" ).split( "," ).filter( function(name) {return !!name} ).sort(),
        exclude = req.param( "exclude", "" ).split( "," ).sort(),
        baseUrl = path.normalize( path.join( wsDir, req.param( "baseUrl", "." ) ) );


    buildDependencyMap( req.params.project, req.params.repo, req.params.ref, baseUrl, names )
        .then( function( content ) {
            res.json( content );
        }, function( err ) {
            res.send( err, 500 );
        });
});

console.log( "listening on port:", httpPort );
app.listen( httpPort );