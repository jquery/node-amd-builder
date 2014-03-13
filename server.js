'use strict';

var _ = require( 'underscore' ),
	express = require( 'express' ),
	app = express(),
	async = require( 'async'),
	crypto = require( 'crypto' ),
	cssConcat = require( 'css-concat' ),
	fetch = require( './lib/project' ).fetch,
	fs = require( 'fs' ),
	logger = require( 'simple-log' ).init( 'amd-builder' ),
	mime = require( 'mime' ),
	path = require( 'path' ),
	promiseUtils = require( 'node-promise' ),
	Promise = require( 'node-promise').Promise,
	when = require( 'node-promise').when,
	regexp = require( './lib/regexp' ),
	requirejs = require( 'requirejs' ),
	semver = require( 'semver' ),
	url = require( 'url' ),
	zip = require("node-native-zip" );

var argv = require( 'optimist' )
	.demand( 'r' )
	.alias( 'r', 'repo-dir')
	.describe( 'r', "Root directory for barebone repositories" )
	.demand( 's' )
	.alias( 's', 'staging-dir')
	.describe( 's', "Root directory for workspaces" )
	.options( 'p', {
		alias: "port",
		default: 3000
	})
	.usage( 'Usage: $0 -r <path> -s <path> [-p <port>]')
	.argv;

var httpPort = argv.port || 3000,
	Project = require( './lib/project' )
	.repoDir( argv.r || process.env.REPO_BASE_DIR )
	.stagingDir( argv.s || process.env.WORK_BASE_DIR )
	.Project,
	filters = {},
	bundlePromises = {},
	dependenciesPromises = {};

logger.log( "Starting up with repos in '" + argv.r + "' and workspaces in '" + argv.s + "'");

app.configure('development', function(){
	app.use( express.errorHandler({ dumpExceptions: true, showStack: true }) );
	app.use( express.logger( 'tiny' ) );
});

app.configure('production', function(){
	app.use( express.logger( { format: '[:date] - :status ":method :url" - :response-time ms' } ) );
});

app.use(express.bodyParser());

function afterProjectCheckout( project ) {
	// Clear caches
	var wsDir = project.getWorkspaceDirSync(),
	filterPath;
	for ( filterPath in filters[ wsDir ] ) {
		delete require.cache[ filterPath ];
		delete filters[ wsDir ][ filterPath ];
	}
	dependenciesPromises = {};
	bundlePromises = {};
}

app.get( '/', function ( req, res ) {
	res.send( "<h1 style='text-align: center; font-size: 120px;'>GitHub based AMD web builder</h1>" );
});

app.post( '/post_receive', function ( req, res ) {
	var payload = req.body.payload,
	owner, repo, repoUrl, ref, refType, refName, project,
	fetchIfExists = function( candidates, callback ) {
		var dir = candidates.shift();
		fs.exists( dir , function( exists ) {
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
					logger.error( "Error in /post_receive route: Workspace for '" + repo + "' hasn't been checked out" );
					res.send( "Workspace for '" + repo + "' hasn't been checked out", 404 );
				}
			}
		});
	};
	// logger.log( "post_receive(): " + payload );
	if ( payload ) {
		try {
			payload = JSON.parse( payload );
			repo = payload.repository.name;
			owner = payload.repository.owner.name;
			ref = payload.ref.split( "/" );
			refName = ref.pop();
			refType = ref.pop();
			project = new Project( owner, repo, refName );

			if ( refType === "tags" && semver.valid( refName ) != null ) {
				logger.log( "/post_receive received SEMVER ref: ", refName, "for SHASUM:", payload.after );
			}

			if ( project ) {
				async.series([
					_.bind( project.fetch, project ),
					function( next ) {
						project.checkout( refType === "tags" && semver.valid( refName ) != null, next );
					}
					],
					function ( err ) {
						if ( err ) {
							logger.error( "Error in /post_receive route: " + err );
							res.send( err, 500 );
						} else {
							afterProjectCheckout( project );
							res.send( "OK" );
						}
					});
				} else {
					res.send( "Payload is missing data", 404 );
				}
			} catch( e ) {
				logger.error( "Error in post_receive route: " + e );
				res.send( e, 500 );
			}
		} else {
			logger.error( "Error in post_receive route: No payload" );
			res.send( "No Payload!", 400 );
		}
	});

	app.get( '/v1/:owner/:repo', function ( req, res ) {
		logger.log( "Fetching " + req.params.owner + "/" + req.params.repo );
		var project = new Project( req.params.owner, req.params.repo );
		async.waterfall([
			_.bind( project.fetch, project ),
			function ( out ) {
				res.send( ( out?"\n":"" ) + "OK" );
			}
			], function( err ) {
				if ( err ) {
					res.send( err, 500 );
				}
			})
		});

		app.get( '/v1/:owner/:repo/:ref', function ( req, res ) {
			logger.log( "Refreshing " + req.params.owner + "/" + req.params.repo + " ref: " + req.params.ref );
			var project = new Project( req.params.owner, req.params.repo, req.params.ref );

			project.checkout(
				function( err ) {
					if ( err ) {
						res.send( err, 500 );
					} else {
						afterProjectCheckout( project );
						res.send( "OK" );
					}
				}
			);
		});

		function redefineRequireJSLogging() {
			// Redefine the logging function for r.js
			requirejs.define( 'node/print', function() {
				function print( msg ) {
					logger.log( "r.js: " + msg );
				}
				return print;
			});
		}

		var bid = 0;
		function buildDependencyMap( project, baseUrl, include ) {
			var id = bid++;
			// logger.log( "buildDependencyMap["+id+"]()" );
			var promise = new Promise(),
			shasum = crypto.createHash( 'sha1' ),
			compileDir = project.getCompiledDirSync(),
			filename = "",
			getFiles = function( dir, filterFn, mapFn, callback ) {
				// Recurse through directories in dir and collect a list of files that gets filtered by filterFn
				// The resulting list is processed by mapFn (remove extension for instance)
				fs.readdir( dir, function( err, dirEntries ) {
					// logger.log( "buildDependencyMap["+id+"](): step 1.1" );
					var filteredFiles, include;

					if ( err ) {
						callback( err );
					} else {
						async.waterfall([
							function( next ) {
								//Filter directories
								async.filter( dirEntries,
									function( dirEntry, callback ) {
										fs.stat( path.join( dir, dirEntry ), function( err, stats ) {
											if ( err ) {
												callback( false );
											} else {
												callback( stats.isDirectory() );
											}
										});
									}, function( results ) {
										next( null, results );
									}
								);
							},
							function( dirs, next ) {
								async.map( dirs,
									function( dirName, callback ) {
										callback( null, path.join( dir, dirName ) );
									}, next );
								},
								function( dirs, next ) {
									async.concat( dirs,
										function( subdir, cb ) {
											getFiles( subdir, filterFn, mapFn, cb );
										}, next
									);
								},
								function( modules, next ) {
									async.filter( dirEntries,
										function( item, callback ) {
											callback( filterFn( item ) );
										},
										function( filteredFiles ) {
											next( null, modules, filteredFiles );
										}
									);
								},
								function( modules, filteredFiles, next ) {
									async.map( filteredFiles,
										function( item, callback ) {
											callback( null, mapFn( path.join( dir, item ) ) );
										},
										function( err, results ) {
											next( err, modules.concat( results ) );
										}
									);
								}
								], function( err, results ) {
									callback( err, results );
								});
							}
						});
					};

					// Setting baseUrl to absolute
					baseUrl = path.normalize( path.join( project.getWorkspaceDirSync(), baseUrl ) );

					async.waterfall([
						function( next ) {
							project.checkoutIfEmpty( next );
						},
						function( next ) {
							// logger.log( "buildDependencyMap["+id+"](): step 1" );
							// If no name is provided, scan the baseUrl for js files and return the dep map for all JS objects in baseUrl
							if ( include && include.length > 0 ) {
								next();
							} else {
								getFiles( baseUrl,
									function( file ) {
										return path.extname( file ) === ".js";
									},
									function( file ) {
										var relPath = path.relative( baseUrl, file );
										return relPath.substring( 0, relPath.length - ".js".length );
									},
									function( err, modules ) {
										include = modules;
										next( err );
									}
								);
							}
						},
						function( next ) {
							// logger.log( "buildDependencyMap["+id+"](): step 2" );
							// Generate a sha on the sorted names
							var digest = shasum.update( include.join( "," ) ).digest( "hex" );

							filename += path.join( compileDir, "deps-" + digest + ".json" );

							fs.exists( filename, function( exists ) {
								next( null, digest, exists )
							});
						},
						function( digest, exists, next ) {
							// logger.log( "buildDependencyMap["+id+"](): step 3" );
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
											// logger.log( "buildDependencyMap["+id+"](): step 3.1" );
											fs.mkdir( compileDir, function( err ) {
												if ( err && err.code != "EEXIST" ) {
													cb( err );
												} else {
													cb();
												}
											});
										},
										function( cb ) {
											// logger.log( "buildDependencyMap["+id+"](): step 3.2" );
											redefineRequireJSLogging();

											requirejs.tools.useLib( function ( r ) {
												r( [ 'parse' ], function ( parse ) {
													cb( null, parse );
												})
											});
										},
										function( parse, cb ) {
											// logger.log( "buildDependencyMap["+id+"](): step 3.3" );
											var deps = {};
											async.forEach( include, function ( name, done ) {
												var fileName = path.join( baseUrl, name + ".js" ),
												dirName = path.dirname( fileName );
												// logger.log( "Processing: " + fileName );
												fs.readFile( fileName, 'utf8', function( err, data ) {
													if ( err ) {
														callback( err );
													}
													deps[ name ] = {};
													deps[ name ].deps = parse.findDependencies( fileName, data ).map(
														function( module ) {
															// resolve relative paths
															return path.relative( baseUrl, path.resolve( dirName, module ));
														}
													);
													done();
												});
											}, function( err ) {
												cb( err, deps );
											});
										},
										function( deps, cb ) {
											// logger.log( "buildDependencyMap["+id+"](): step 3.4" );
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
															// logger.log( "buildDependencyMap["+id+"](): step 3.4.1" );
															fs.readFile( path.join( baseUrl, item+".js" ), 'utf8', next );
														},
														function( data, next ) {
															// logger.log( "buildDependencyMap["+id+"](): step 3.4.2" );
															var lines = data.split( "\n" ),
															matches = lines.filter( function( line, index ) {
																return /^.*\/\/>>\s*[^:]+:.*$/.test( line );
															});
															if ( matches && matches.length ) {
																matches.forEach( function( meta ) {
																	var attr = meta.replace( /^.*\/\/>>\s*([^:]+):.*$/, "$1" ).trim(),
																	attrLabelRE = new RegExp( "^.*" + regexp.escapeString( "//>>" + attr + ":") + "\\s*", "m" ),
																	value = meta.replace( attrLabelRE, "" ).trim(),
																	namespace, name,
																	indexOfDot = attr.indexOf( "." );
																	if ( indexOfDot > 0 ) { // if there is something before the dot
																		namespace = attr.split( "." )[0];
																		name = attr.substring( indexOfDot+1 );
																		deps[ item ][ namespace ] = deps[ item ][ namespace ] || {};
																		deps[ item ][ namespace ][ name ] = value;
																	} else {
																		deps[ item ][ attr ] = value;
																	}
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
												// logger.log( "buildDependencyMap["+id+"](): step 3.5" );
												fs.writeFile( filename, JSON.stringify( deps ), "utf8",
												function( err ) {
													cb( err, deps );
												}
											);
										}
										], next );
									} else {
										dependenciesPromises[ digest ].then(
											function( data ) {
												next( null, data );
											},
											next
										);
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

						function applyFilter( baseUrl, filter, contents, ext, callback ) {
							if ( filter ) {
								require( path.join( baseUrl, filter ) )( contents, ext, callback );
							} else {
								callback( null, contents );
							}
						}

						function buildCSSBundles( project, config, name, filter, optimize ) {
							// logger.log( "buildCSSBundle()" );
							var promise = new Promise(),
							baseUrl = path.normalize( path.join( project.getWorkspaceDirSync(), config.baseUrl ) ),
							include = config.include,
							baseOut = path.join( project.getCompiledDirSync(), name );

							// get the dependency map for all modules
							buildDependencyMap( project, config.baseUrl ).then(
								function( modules ) {
									var cssFiles = {
									default: []
								},
								contents =  {
								default: ""
							},
							outputFiles = [];

							async.waterfall([
								function( next ) {
									var name,
									processed = {},
									addCssDependencies = function( m ) {
										processed[ m ] = true;
										if ( !processed[ m ] && modules[ m ] &&  modules[ m ].deps ) {
											modules[ m ].deps.forEach( addCssDependencies );
										}
										if ( modules[ m ] && modules[ m ].css ) {
											if ( typeof( modules[ m ].css ) === "string" ) {
												// logger.log( "Adding: " + modules[ m ].css );
												cssFiles.default = _.union( cssFiles.default, modules[ m ].css.split(",") );
											} else {
												for ( name in modules[ m ].css ) {
													if ( modules[ m ].css.hasOwnProperty( name ) ) {
														cssFiles[ name ] = cssFiles[ name ] || [];
														// logger.log( "Adding css." + name + ": " + modules[ m ].css[ name ] );
														cssFiles[ name ] = _.union( cssFiles[ name ], modules[ m ].css[ name ].split(",") );
													}
												}
											}
										}
									};

									include.forEach( addCssDependencies );
									next();
								},
								function( next ) {
									var keys = Object.keys( cssFiles );

									keys.forEach( function( name ) {
										if ( cssFiles.hasOwnProperty( name ) ) {
											// resolve the file paths
											cssFiles[ name ] = _.uniq( cssFiles[ name ] ).map( function( s ) {
												return path.resolve( baseUrl, s.trim() );
											});

											contents[ name ] = "";
											cssFiles[ name ].forEach( function( file ) {
												contents[ name ] += "\n";
												try {
													contents[ name ] += cssConcat.concat( file, { comments: false } );
												} catch ( e ) {
													next( e.toString() );
												}
											});
											contents[ name ] = contents[ name ].trim();
											if ( contents[ name ].length === 0 ) {
												if ( optimize ) {
													logger.log( name, "CSS file is empty, removing it from optimized bundle" );
												} else {
													logger.log( name, "CSS file is empty, removing it from bundle" );
												}
												delete contents[ name ];
												delete cssFiles[ name ];
											}
										}
									});
									next();
								},
								function ( next ) {
									async.forEach(
										Object.keys( contents ),
										function( key, callback ) {
											var unoptimizedOut = baseOut + ( key === "default"? "" : ( "." + key ) ) + ".css";

											async.waterfall([
												function( step ) {
													applyFilter( baseUrl, filter, contents[ key ], ".css", step );
												},
												function ( content, step ) {
													fs.writeFile( unoptimizedOut, content, 'utf8', step );
												},
												function ( step ) {
													if ( !optimize ) {
														outputFiles.push( unoptimizedOut );
													}
													step();
												}
												], callback );

											},
											next
										);
									},
									function( next ) {
										async.forEach(
											Object.keys( contents ),
											function( key, callback ) {
												var unoptimizedOut = baseOut + ( key === "default"? "" : ( "." + key ) ) + ".css",
												optimizedOut = baseOut + ( key === "default"? "" : ( "." + key ) ) + ".min.css";

												try {
													process.chdir( project.getWorkspaceDirSync() );
												}
												catch ( e1 ) {
													next( e1.toString() );
												}

												redefineRequireJSLogging();

												try {
													requirejs.optimize(
														{
															cssIn: unoptimizedOut,
															out: optimizedOut,
															optimizeCss: "standard",
															logLevel: 4 // SILENT
														},
														function( response ) {
															async.waterfall([
																function( step ) {
																	fs.readFile( optimizedOut, "utf-8", step );
																},
																function( content, step ) {
																	applyFilter( baseUrl, filter, content, ".min.css", step );
																},
																function ( content, step ) {
																	fs.writeFile( optimizedOut, content, 'utf8', step );
																},
																function ( step ) {
																	if ( optimize ) {
																		outputFiles.push( optimizedOut );
																	}
																	step();
																}
																], callback );
															},
															function( err ) {
																// We're expecting a string as the error.
																next( err.message );
															}
														);
													} catch ( e2 ){
														next( e2.toString() );
													}
												},
												next
											);
										}
										], function( err ) {
											if( err ) {
												promise.reject( err );
											} else {
												if ( outputFiles.length === 0 || outputFiles.length > 1 ) {
													promise.resolve( outputFiles );
												} else {
													promise.resolve( outputFiles[ 0 ] );
												}
											}
										});
									},
									function( err ) {
										promise.reject( err );
									}
								);
								return promise;
							}

							var bjsid = 0;
							function buildJSBundle( project, config, name, filter, optimize ) {
								var id = bjsid ++;
								// logger.log( "buildJSBundle["+id+"]()" );
								var promise = new Promise(),
								baseUrl = path.normalize( path.join( project.getWorkspaceDirSync(), config.baseUrl ) ),
								wsDir = project.getWorkspaceDirSync(),
								ext = ( optimize ? ".min" : "" ) + ".js",
								out = path.join( project.getCompiledDirSync(), name + ext );

								fs.exists( out, function ( exists ) {
									if ( exists ) {
										// logger.log( "buildJSBundle: resolving promise" );
										promise.resolve( out );
									} else {
										async.waterfall([
											function( next ) {
												// logger.log( "buildJSBundle["+id+"](): step 1" );
												var outDir = path.dirname( config.out );
												// logger.log( "mkdir '" + outDir + "'" );
												fs.mkdir( outDir, function( err ) {
													if ( err && err.code != "EEXIST" ) {
														next( err );
													} else {
														next();
													}
												});
											},
											function( next ) {
												// logger.log( "buildJSBundle["+id+"](): step 2" );
												try {
													process.chdir( project.getWorkspaceDirSync() );
												}
												catch ( e1 ) {
													next( e1.toString() );
												}

												redefineRequireJSLogging();

												try {
													requirejs.optimize(
														_.extend({
															out: out,
															optimize: ( optimize ? "uglify" : "none" ),
															logLevel: 4 // SILENT
														}, config ),
														function( response ) {
															next( null, response );
														},
														function( err ) {
															// We're expecting a string as the error.
															next( err.message );
														}
													);
												} catch ( e2 ){
													next( e2.toString() );
												}
											},
											function( response, next ) {
												// logger.log( "buildJSBundle["+id+"](): step 3" );
												fs.readFile( out, 'utf8', next );
											},
											function ( contents, next ) {
												// logger.log( "buildJSBundle["+id+"](): step 4" );
												applyFilter( baseUrl, filter, contents, ext, next );
											},
											function( contents, next ) {
												fs.writeFile( out, contents, 'utf8', next );
											}
											], function( err ) {
												if( err ) {
													promise.reject( err );
												} else {
													// logger.log( "buildJSBundle: resolving promise" );
													promise.resolve( out );
												}
											});
										}
									});
									return promise;
								}

								function buildZipBundle( project, name, config, digest, filter )  {
									// logger.log( "buildZipBundle()" );
									var promise = new Promise(),
									baseUrl = config.baseUrl,
									basename = path.basename( name, ".zip" ),
									out = path.join( project.getCompiledDirSync(), digest + ".zip" );

									fs.exists( out, function ( exists ) {
										if ( exists ) {
											promise.resolve( out );
										} else {
											promiseUtils.allOrNone([
												buildCSSBundles( project, config, digest, filter ),
												buildCSSBundles( project, config, digest, filter, true ),
												buildJSBundle( project, config, digest, filter ),
												buildJSBundle( project, config, digest, filter, true )
												]).then(
													function( results ) {
														var archive = new zip();

														async.series([
															function( next ) {
																async.forEachSeries( results, function( bundle, done ) {
																	var nameInArchive;
																	if ( bundle && bundle.length > 0 ) {
																		if ( typeof( bundle ) === "string" ) {
																			nameInArchive = path.basename( bundle ).replace( digest, name.substring( 0, name.lastIndexOf( "." )) );
																			archive.addFiles( [{ name: nameInArchive, path: bundle }], done );
																		} else {
																			archive.addFiles(
																				bundle.map( function( file ) {
																					var nameInArchive = path.basename( file ).replace( digest, name.substring( 0, name.lastIndexOf( "." )) );
																					return( { name: nameInArchive, path: file } );
																				}), done
																			);
																		}
																	} else {
																		done();
																	}
																}, next );
															},
															function( next ) {
																fs.writeFile( out, archive.toBuffer(), next );
															}
															], function( err ) {
																if( err ) {
																	promise.reject( err );
																} else {
																	promise.resolve( out );
																}
															});
														},
														function( err ) {
															promise.reject( err );
														}
													)
												}
											});
											return promise;
										}

										app.get( '/v1/bundle/:owner/:repo/:ref/:name?', function ( req, res ) {
											logger.log( "Building bundle for " + req.params.owner + "/" + req.params.repo + " ref: " + req.params.ref );
											var project = new Project( req.params.owner, req.params.repo, req.params.ref ),
											include = req.param( "include", "main" ).split( "," ).sort(),
											exclude = req.param( "exclude", "" ).split( "," ).sort(),
											optimize = Boolean( req.param( "optimize", false ) ).valueOf(),
											name = req.params.name || ( req.params.repo + ".js" ),
											ext = (optimize !== "none" ? ".min" : "") + ( path.extname( name ) || ".js" ),
											mimetype = mime.lookup( ext ),
											filter = req.param( "filter" ),
											shasum = crypto.createHash( 'sha1' ),
											wsDir   = project.getWorkspaceDirSync(),
											args = _.clone( req.query ),
											digest, hash;

											// Remove config params that need pre-processing or don't belong in the requirejs config
											[ "include", "exclude", "filter" ].forEach( function( key ) {
												delete args[ key ];
											});

											// Parse the config attribute, if it throws it's probably a string, no biggie
											Object.keys( args ).forEach( function( key ) {
												try {
													args[ key ] = JSON.parse( args[ key ] );
												} catch( e ) {
													// It's not really an error. If it's a string it'll throw, that's fine.
													// logger.log( "JSON.parse threw while parsing '" + key + "': " + e );
												}
											});

											// var baseUrlFilters[baseUrl] = require(path.join(baseUrl, 'somemagicnameOrpackage.jsonEntry.js'));
											var config = _.extend({
												include: include,
												exclude: exclude,
												skipModuleInsertion: false ,
												preserveLicenseComments: true
											}, args );

											shasum.update( req.params.repo );
											shasum.update( req.params.ref );
											shasum.update( JSON.stringify( config ) );
											shasum.update( mimetype );
											if ( filter ) {
												shasum.update( filter );
											}

											if ( mimetype === "application/zip" ) {
												// For the zip file, the name needs to be part of the hash because it will determine the name of the files inside the zip file
												shasum.update( name );
											}

											digest = shasum.digest( 'hex' );

											logger.log( digest + ": " + JSON.stringify( config ) );

											if ( filter ) {
												// Setting the flag for later clean up
												filters[ project.getWorkspaceDirSync() ] = filters[ project.getWorkspaceDirSync() ] || {};
												filters[ project.getWorkspaceDirSync() ][ path.join( wsDir, config.baseUrl, filter ) ] = true;
											}

											if ( mimetype === "application/zip" ) {
												hash = digest;
											} else {
												hash += ( optimize ? ".min" : "" );
											}

											function onBundleBuildError( error ) {
												//        res.header( "Access-Control-Allow-Origin", "*");
												if ( typeof error === "string" ){
													res.json( 500, { error: error } );
												} else {
													res.json( 500, { error: error.message } );
												}
												delete bundlePromises[ digest ];
											}

											function buildBundle() {
												var hash = digest;
												if ( mimetype === "application/zip" ) {
													bundlePromises[ hash ] = buildZipBundle( project, name, config, digest, filter );
												} else if ( mimetype === "text/css" ) {
													bundlePromises[ hash ] = buildCSSBundles( project, config, digest, filter, optimize );
												} else {
													bundlePromises[ hash ] = buildJSBundle( project, config, digest, filter, optimize );
												}
												bundlePromises[ hash ].then( onBundleBuilt, onBundleBuildError );
											}

											function onBundleBuilt( bundle ) {
												var out,
												promise = new Promise();

												// Set up our promise callbacks
												promise.then(
													function( bundleInfo ) {
														res.header( "Access-Control-Allow-Origin", "*");
														res.download( bundleInfo.path, bundleInfo.name );
													},
													function() {
														// Try to land back on our feet if for some reasons the built bundle got cleaned up;
														delete bundlePromises[ hash ];
														buildBundle();
													}
												);

												if ( typeof( bundle ) === "string" ) {
													fs.exists( bundle, function ( exists ) {
														if ( exists ) {
															promise.resolve( { path: bundle, name: name } );
														} else {
															promise.reject();
														}
													});
												} else {
													out = path.join( project.getCompiledDirSync(), digest + ext + ".zip" );
													fs.exists( out, function ( exists ) {
														var archive;
														if ( exists ) {
															promise.resolve( { path: out, name: name } );
														} else {
															archive = new zip();
															async.series([
																function( next ) {
																	archive.addFiles(
																		bundle.map( function( file ) {
																			var nameInArchive = path.basename( file ).replace( digest, name.substring( 0, name.lastIndexOf( "." )) );
																			return( { name: nameInArchive, path: file } );
																		}),
																		next
																	);
																},
																function( next ) {
																	fs.writeFile( out, archive.toBuffer(), next );
																}
																],
																function( err ) {
																	if( err ) {
																		promise.reject();
																	} else {
																		promise.resolve( { path: out, name: name + ".zip" } );
																	}
																});
															}
														});
													}
												}

												if ( !bundlePromises[ hash ] ) {
													buildBundle();
												} else {
													bundlePromises[ hash ].then( onBundleBuilt, onBundleBuildError );
												}
											});

											app.get( '/v1/dependencies/:owner/:repo/:ref', function ( req, res ) {
												var project = new Project( req.params.owner, req.params.repo, req.params.ref ),
												names = req.param( "names", "" ).split( "," ).filter( function(name) {return !!name} ).sort(),
												exclude = req.param( "exclude", "" ).split( "," ).sort(),
												baseUrl = req.param( "baseUrl", "." );

												buildDependencyMap( project, baseUrl, names )
												.then( function( content ) {
													res.header( "Access-Control-Allow-Origin", "*");
													res.json( content );
												}, function( err ) {
													res.send( 500, { error: err } );
												});
											});

											logger.log( "listening on port: " + httpPort );
											app.listen( httpPort );
