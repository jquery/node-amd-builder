"use strict";

var _ = require( 'lodash' ),
	applyFilter = require( './filter' ).apply,
	async = require( "async" ),
	cssConcat = require( 'css-concat' ),
	dependencies = require( "./dependencies" ),
	fs = require( "fs" ),
	logger = require( './simple-log' ).init( 'amd-builder:css' ),
	path = require( 'path' ),
	Promise = require( "node-promise" ).Promise,
	requirejs = require( 'requirejs' ),
	redefineRequireJSLogging = require( "./requirejs-utils" ).redefineRequireJSLogging;


function buildBundles( baseName, workspaceDir, relBaseUrl, compiledDir, amdModules, filter, optimize ) {
	// logger.log( "buildCSSBundle()" );
	var promise = new Promise(),
		baseOut = path.join( compiledDir, baseName );

	// get the dependency map for all modules
	dependencies.buildMap( workspaceDir, relBaseUrl, compiledDir, amdModules ).then(
		function( modules ) {
			var absBaseUrl = path.normalize( path.join( workspaceDir, relBaseUrl ) ),
				cssFiles = {
					default: []
				},
				contents = {
					default: ""
				},
				outputFiles = [];

			async.waterfall([
				function( next ) {
					var processed = {},
						addCssDependencies = function( m ) {
							processed[ m ] = true;
							if ( !processed[ m ] && modules[ m ] && modules[ m ].deps ) {
								modules[ m ].deps.forEach( addCssDependencies );
							}
							if ( modules[ m ] && modules[ m ].css ) {
								if ( typeof( modules[ m ].css ) === "string" ) {
									// logger.log( "Adding: " + modules[ m ].css );
									cssFiles.default = _.union( cssFiles.default, modules[ m ].css.split( "," ) );
								} else {
									for ( var name in modules[ m ].css ) {
										if ( modules[ m ].css.hasOwnProperty( name ) ) {
											cssFiles[ name ] = cssFiles[ name ] || [];
											// logger.log( "Adding css." + name + ": " + modules[ m ].css[ name ]);
											cssFiles[ name ] = _.union( cssFiles[ name ], modules[ m ].css[ name ].split( "," ) );
										}
									}
								}
							}
						};

					amdModules.forEach( addCssDependencies );
					next();
				},
				function( next ) {
					var keys = Object.keys( cssFiles );

					keys.forEach( function( name ) {
						if ( cssFiles.hasOwnProperty( name ) ) {
							// resolve the file paths
							cssFiles[ name ] = _.uniq( cssFiles[ name ]).map( function( s ) {
								return path.resolve( absBaseUrl, s.trim() );
							});

							contents[ name ] = "";
							cssFiles[ name ].forEach( function( file ) {
								contents[ name ] += "\n";
								try {
									contents[ name ] += cssConcat.concat( file, { comments: false });
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
				function( next ) {
					async.forEach(
						Object.keys( contents ),
						function( key, callback ) {
							var unoptimizedOut = baseOut + ( key === "default" ? "" : ( "." + key ) ) + ".css";

							async.waterfall([
								function( step ) {
									applyFilter( absBaseUrl, filter, contents[ key ], ".css", step );
								},
								function( content, step ) {
									fs.writeFile( unoptimizedOut, content, 'utf8', step );
								},
								function( step ) {
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
							var unoptimizedOut = baseOut + ( key === "default" ? "" : ( "." + key ) ) + ".css",
								optimizedOut = baseOut + ( key === "default" ? "" : ( "." + key ) ) + ".min.css";

							try {
								process.chdir( workspaceDir );
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
									function() {
										async.waterfall([
											function( step ) {
												fs.readFile( optimizedOut, "utf-8", step );
											},
											function( content, step ) {
												applyFilter( absBaseUrl, filter, content, ".min.css", step );
											},
											function( content, step ) {
												fs.writeFile( optimizedOut, content, 'utf8', step );
											},
											function( step ) {
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
							} catch ( e2 ) {
								next( e2.toString() );
							}
						},
						next
					);
				}
			], function( err ) {
				if ( err ) {
					logger.error( err );
					promise.reject( err );
				} else {
					if ( outputFiles.length === 0 || outputFiles.length > 1 ) {
						promise.resolve( outputFiles );
					} else {
						promise.resolve( outputFiles[ 0 ]);
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

exports.buildBundles = buildBundles;
