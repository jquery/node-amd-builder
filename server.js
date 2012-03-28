'use strict';

var _ = require( 'underscore' ),
    express = require( 'express' ),
    app = express.createServer(),
    async = require( 'async'),
    crypto = require( 'crypto' ),
    cssConcat = require( 'css-concat' ),
    fs = require( 'fs' ),
    Git = require( './lib/git'),
    exec = require( 'child_process' ).exec,
    mime = require( 'mime' ),
    path = require( 'path' ),
    Promise = require( 'node-promise').Promise,
    when = require( 'node-promise').when,
    regexp = require( './lib/regexp' ),
	requirejs = require( 'requirejs' ),
    rimraf = require( 'rimraf' ),
    url = require( 'url' );

var httpPort = process.env.PORT || 8080,
    repoBaseDir = path.normalize( process.env.REPO_BASE_DIR ),
    workBaseDir = path.normalize ( process.env.WORK_BASE_DIR ),
    filters = {},
    bundlePromises = {},
    dependenciesPromises = {};

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
    res.send( "<h1 style='text-align: center; font-size: 120px;'>GitHub based AMD web builder</h1>" );
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
            dependenciesPromises = {};
            bundlePromises = {};
            next();
        }
    ], callback );

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
                    getRepoDir( project, repo, next );
                },
                function( dir, next ) {
                    Git( dir, workDir );
                    Git.exec( [ "checkout", "-f", ref ], next );
                },
                function( out, next ) {
                    cleanup( project, repo, ref, next );
                }
            ], callback );
        } else {
            callback( "Worspace for " + repo + "/" + ref + " has not been created" );
        }
    });
}

function getFirstExistingDir( candidates, callback ) {
    console.log( "getFirstExistingDir" );
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
    console.log( "post_receive(): " + payload );
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
                function ( err ) {
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

var bid = 0;
function buildDependencyMap( project, repo, ref, baseUrl, include ) {
    var id = bid++;
    console.log( "buildDependencyMap["+id+"]()" );
    var promise = new Promise(),
        shasum = crypto.createHash( 'sha1' ),
        compileDir = getCompiledDirSync( project, repo, ref ),
        filename = "";

    async.waterfall([
        function( next ) {
            console.log( "buildDependencyMap["+id+"](): step 1" );
            // If no name is provided, scan the baseUrl for js files and return the dep map for all JS objects in baseUrl
            if ( include && include.length > 0 ) {
                next();
            } else {
                fs.readdir( baseUrl, function( err, files ) {
                    console.log( "buildDependencyMap["+id+"](): step 1.1" );
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
            console.log( "buildDependencyMap["+id+"](): step 2" );
            // Generate a sha on the sorted names
            var digest = shasum.update( include.join( "," ) ).digest( "hex" );

            filename += path.join(compileDir, "deps-" + digest + ".json" );

            path.exists( filename, function( exists ) {
                next( null, digest, exists )
            });
        },
        function( digest, exists, next ) {
            console.log( "buildDependencyMap["+id+"](): step 3" );
            if ( exists ){
                fs.readFile( filename, "utf8", function( err, data ) {
                    if ( err ) {
                        next( err );
                    } else {
                        next( err, JSON.parse( data ) );
                    }
                });
            } else {
                if ( !dependenciesPromises[ digest ] ) {
                    dependenciesPromises[ digest ] = promise;
                    async.waterfall([
                        function( cb ) {
                            console.log( "buildDependencyMap["+id+"](): step 3.1" );
                            console.log( "mkdir '" + compileDir + "'" );
                            fs.mkdir( compileDir, function( err ) {
                                if ( err && err.code != "EEXIST" ) {
                                    cb( err );
                                } else {
                                    cb( null );
                                }
                            });
                        },
                        function( cb ) {
                            console.log( "buildDependencyMap["+id+"](): step 3.2" );
                            requirejs.tools.useLib( function ( r ) {
                                r( [ 'parse' ], function ( parse ) {
                                    cb( null, parse );
                                })
                            });
                        },
                        function( parse, cb ) {
                            console.log( "buildDependencyMap["+id+"](): step 3.3" );
                            var deps = {};
                            async.forEach( include, function ( name, done ) {
                                var fileName = path.join( baseUrl, name + ".js" );
                                console.log( "Processing: " + fileName );
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
                            console.log( "buildDependencyMap["+id+"](): step 3.4" );
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
                                            console.log( "buildDependencyMap["+id+"](): step 3.4.1" );
                                            fs.readFile( path.join( baseUrl, item+".js" ), 'utf8', next );
                                        },
                                        function( data, next ) {
                                            console.log( "buildDependencyMap["+id+"](): step 3.4.2" );
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
                                    ], callback );
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
                            console.log( "buildDependencyMap["+id+"](): step 3.5" );
                            fs.writeFile( filename, JSON.stringify( deps ), "utf8",
                                function( err ) {
                                    cb( err, deps );
                                }
                            );
                        }
                    ], next );
                } else {
                    dependenciesPromises[ digest ].then( function( data ) {
                        next( null, data );
                    },
                    next );
                }
            }
        }
    ], function( err, data ) {
        if ( err ) {
            promise.reject( err );
        } else {
            promise.resolve( data );
        }
    });
    return promise;
}

function buildCSSBundle( project, repo, ref, config ) {
    console.log( "buildCSSBundle()" );
    var promise = new Promise(),
        baseUrl = config.baseUrl,
        include = config.include,
        shasum = crypto.createHash( 'sha1' ),
        out = config.out;

    path.exists( out, function ( exists ) {
        if ( exists ) {
            console.log( "buildCSSBundle: resolving promise" );
            promise.resolve( out );
        } else {
            // get the dependency map for all modules
            buildDependencyMap( project, repo, ref, baseUrl ).then(
                function( modules ) {
                    var cssFiles = [],
                        contents =  "";

                    async.series([
                        function( next ) {
                            async.forEach( config.include, function( module, done ) {
                                var addCssDependencies = function( m ) {
                                    m = m.replace( /^.*!/, "" );  // remove the plugin part
                                    m = m.replace( /\[.*$/, "" ); // remove the plugin arguments at the end of the path
                                    m = m.replace( /^\.\//, "" ); // remove the relative path "./"
                                    if ( modules[ m ] &&  modules[ m ].deps ) {
                                        modules[ m ].deps.forEach( addCssDependencies );
                                    }
                                    if ( modules[ m ] && modules[ m ].css ) {
                                        console.log( "Adding: " + modules[ m ].css );
                                        Array.prototype.push.apply( cssFiles, modules[ m ].css.split(",") );
                                    }
                                };
                                addCssDependencies( module );
                                done();
                            }, next )
                        },
                        function( next ) {
                            // resolve the file paths
                            cssFiles = _.uniq( cssFiles ).map( function( s ) {
                                return path.resolve( baseUrl, s.trim() );
                            });

                            cssFiles.forEach( function( file ) {
                                contents += "\n";
                                try {
                                    contents += cssConcat.concat( file );
                                } catch ( e ) {
                                    next( e.toString() );
                                }
                            });
                            contents = contents.trim();

                            fs.writeFile( out, contents, 'utf8', next );
                        }
                    ], function( err ) {
                        if( err ) {
                            promise.reject( err );
                        } else {
                            console.log( "buildCSSBundle: resolving promise" );
                            promise.resolve( out );
                        }
                    });
                },
                function( err ) {
                    promise.reject( err );
                }
            );
        }
    });
    return promise;
}

var bjsid = 0;
function buildJSBundle( project, repo, ref, config, filter ) {
    var id = bjsid ++;
    console.log( "buildJSBundle["+id+"]()" );
    var promise = new Promise(),
        baseUrl = config.baseUrl,
        wsDir = getWorkspaceDirSync( project, repo, ref ),
        out = config.out;
    path.exists( out, function ( exists ) {
        if ( exists ) {
            console.log( "buildJSBundle: resolving promise" );
            promise.resolve( out );
        } else {
            async.waterfall([
                function( next ) {
                    console.log( "buildJSBundle["+id+"](): step 1" );
                    var outDir = path.dirname( config.out );
                    console.log( "mkdir '" + outDir + "'" );
                    fs.mkdir( outDir, function( err ) {
                        if ( err && err.code != "EEXIST" ) {
                            next( err );
                        } else {
                            next();
                        }
                    });
                },
                function( next ) {
                    console.log( "buildJSBundle["+id+"](): step 2" );
                    requirejs.optimize( config, function( response ) {
                        next( null, response );
                    });
                },
                function( response, next ) {
                    console.log( "buildJSBundle["+id+"](): step 3" );
                    fs.readFile( config.out, 'utf8', next );
                },
                function ( contents, next ) {
                    console.log( "buildJSBundle["+id+"](): step 4" );
                    var filterPath = path.join( baseUrl, filter );
                    if ( filter ) {
                        filters[ wsDir ] = filters[ wsDir ] || {};
                        filters[ wsDir ][ filterPath ] = require( filterPath );
                        contents = filters[ wsDir ][ filterPath ]( contents );
                    }
                    fs.writeFile( out, contents, 'utf8', next );
                }
            ], function( err ) {
                if( err ) {
                    promise.reject( err );
                } else {
                    console.log( "buildJSBundle: resolving promise" );
                    promise.resolve( out );
                }
            });
        }
    });
    return promise;
}

app.get( '/v1/bundle/:project/:repo/:ref/:name?', function ( req, res ) {
    var include = req.param( "include", "main" ).split( "," ).sort(),
        exclude = req.param( "exclude", "" ).split( "," ).sort(),
        optimize = req.param( "optimize", "none" ),
        baseUrl = req.param( "baseUrl", "." ),
        pragmas = JSON.parse( req.param( "pragmas", "{}" ) ),
        pragmasOnSave = JSON.parse( req.param( "pragmasOnSave", "{}" ) ),
        name = req.params.name || ( req.params.repo + ".js" ),
        ext = (optimize !== "none" ? ".min" : "") + ( path.extname( name ) || ".js" ),
        mimetype = mime.lookup( ext ),
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
        pragmasOnSave: pragmasOnSave,
        skipModuleInsertion: req.param( "skipModuleInsertion", false )
	};

    shasum.update( JSON.stringify( config ) );
    shasum.update( mimetype );
    if ( filter ) {
        shasum.update( filter );
    }

    digest = shasum.digest( 'hex' );

    dstDir = getCompiledDirSync( req.params.project, req.params.repo, req.params.ref );
    dstFile = path.join( dstDir, digest + ext );

    config.out = dstFile;
    config.optimize = optimize;

    function onBundleBuildError( error ) {
        res.header( "Access-Control-Allow-Origin", "*");
        res.send( error, 500 );
        delete bundlePromises[ digest ];
    }

    function buildBundle() {
        if ( mimetype === "text/css" ) {
            bundlePromises[ digest ] = buildCSSBundle( req.params.project, req.params.repo, req.params.ref, config );
        } else {
            bundlePromises[ digest ] = buildJSBundle( req.params.project, req.params.repo, req.params.ref, config, filter );
        }
        bundlePromises[ digest ].then( onBundleBuilt, onBundleBuildError );
    }

    function onBundleBuilt( bundle ) {
        path.exists( bundle, function ( exists ) {
            if ( exists ) {
                res.header( "Access-Control-Allow-Origin", "*");
                res.download( bundle, name );
            } else {
                // Try to land back on our feet if for some reasons the built bundle got cleaned up;
                delete bundlePromises[ digest ];
                buildBundle();
            }
        });
    }

    if ( !bundlePromises[ digest ] ) {
        buildBundle();
    } else {
        bundlePromises[ digest ].then( onBundleBuilt, onBundleBuildError );
    }
});

app.get( '/v1/dependencies/:project/:repo/:ref', function ( req, res ) {
    var wsDir = getWorkspaceDirSync( req.params.project, req.params.repo, req.params.ref ),
        names = req.param( "names", "" ).split( "," ).filter( function(name) {return !!name} ).sort(),
        exclude = req.param( "exclude", "" ).split( "," ).sort(),
        baseUrl = path.normalize( path.join( wsDir, req.param( "baseUrl", "." ) ) );

    buildDependencyMap( req.params.project, req.params.repo, req.params.ref, baseUrl, names )
        .then( function( content ) {
            res.header( "Access-Control-Allow-Origin", "*");
            res.json( content );
        }, function( err ) {
            res.send( err, 500 );
        });
});

console.log( "listening on port:", httpPort );
app.listen( httpPort );