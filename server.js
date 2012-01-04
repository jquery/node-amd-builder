'use strict';

var express = require( 'express' ),
    app = express.createServer(),
    crypto = require( 'crypto' ),
    fs = require( 'fs' ),
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
};

function checkout( repo, tag, callback ){
    var wsDir  = workBaseDir + "/" + repo + "." + tag;

    fs.mkdir( dstDir, function () {
        exec( "git --work-tree=" + wsDir + " checkout -f " + tag,
            {
                encoding: 'utf8',
                timeout: 0,
                cwd: wsDir,
                env: null
            },
            callback
        );
    });
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
        onFetch = function ( error, stdout, stderr ) {
            if ( error !== null ) {
                res.send( error, 500 );
            } else {
                res.send( stdout );
            }
        },
        fetchIfExists = function( candidates ) {
            path.exists( candidates.shift() , function( exists ) {
                if ( exists ) {
                    fetch( repoDir, onFetch );
                } else {
                    if ( candidates.length ) {
                        fetchIfExists( candidates );
                    } else {
                        res.send( "Wrong door!", 404 );
                    }
                }
            });
        };

    if ( payload ) {
        try {
            payload = JSON.parse( payload );

            if ( payload.repository && payload.repository.name ) {
                var repoDir = repoBaseDir + "/" + payload.repository.name;
                fetchIfExists( [ repoDir, repoDir + ".git" ] );
            } else {
                res.send( "Wrong door!", 404 );
            }
        } catch( e ) {
            res.send( e, 500 );
        }
    } else {
        res.send( "No Payload!", 400 );
    }
});

app.get( '/:repo/:tag/checkout', function ( req, res ) {
    var wsDir   = workBaseDir + "/" + req.params.repo + "." + req.params.tag;

    fs.mkdir( dstDir, function () {
        exec( "git --work-tree=" + wsDir + " checkout -f " + req.params.tag,
            {
                encoding: 'utf8',
                timeout: 0,
                cwd: wsDir,
                env: null
            },
            function ( error, stdout, stderr ) {
                console.log( 'stdout: ' + stdout );
                console.log( 'stderr: ' + stderr );
                if ( error !== null ) {
                    res.send( error, 500 );
                } else {
                    res.send( stdout );
                }
            }
        );
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
        wsDir   = workBaseDir + "/" + req.params.repo + "." + req.params.tag,
        dstDir, dstFile;

	//Set up the config passed to the optimizer
	var config = {
		baseUrl: wsDir + "/" + baseUrl,
		include: include,
        pragmas: pragmas,
        pragmasOnSave: pragmasOnSave
	};

    shasum.update( JSON.stringify( config ) );

    dstDir = wsDir + "/compiled/" + shasum.digest( 'hex' );
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
    var wsDir   = workBaseDir + "/" + req.params.repo + "." + req.params.tag,
        exclude = req.param( "exclude", "" ).split( "," ).sort(),
        names = req.param( "names", req.params.repo ).split( "," ).sort(),
        baseUrl = path.normalize( wsDir + "/" + req.param( "baseUrl", "." ) ),
        shasum = crypto.createHash( 'sha1' ),
        filename = wsDir + "/deps-";

    // Generate a sha on the sorted names
    shasum.update( names.join( "," ) );
    filename += shasum.digest( 'hex' ) + ".json";

    path.exists( filename, function( exists ) {
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
    });
});

console.log( "listening on port:", httpPort );
app.listen( httpPort );