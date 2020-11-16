#!/usr/bin/env node

'use strict';

const [ major, minor ] = process.version
	.replace(/^v/, '')
	.split('.')
	.map( part => Number( part ) );

if ( major < 14 || major === 14 && minor < 14 ) {
	console.error( "Node.js v14.14.0 or higher is required" );
	process.exitCode = 1;
	return;
}

const mobileVersions = [
	"1.5.0-rc1",
	"1.5.0-alpha.1",
	"1.4.5",
	"1.4.4",
	"1.4.3",
	"1.3.2",
	"1.2.1",
	"1.1.2",
];

const fs = require( "fs" ).promises;
const { existsSync, createWriteStream } = require( "fs" );
const path = require( "path" );
const { spawn } = require( "child_process" );
const https = require( "https" );
const AdmZip = require( "adm-zip" );

const rootPath = path.resolve( __dirname, ".." );

const download = async ( url, dest ) => new Promise( ( resolve, reject ) => {
	const file = createWriteStream( dest );

	const request = https.get( url, ( response ) => {
		if ( response.statusCode === 301 || response.statusCode === 302 ) {
			resolve( download( response.headers.location, dest ) );
		}

		if ( response.statusCode !== 200 ) {
			reject( new Error( `Response status was ${ response.statusCode }` ) );
			return;
		}

		response.pipe( file );
	} );

	file.on( "finish", () => {
		resolve();
	} );

	// check for request error too
	request.on( "error", async ( err ) => {
		await fs.unlink( dest );
		reject( err );
	} );

	file.on( "error", async ( err ) => { // Handle errors
		await fs.unlink( dest );
		reject( err );
	} );
} );

const downloadVersion = async version => {
	console.log( `Setting up jQuery Mobile ${ version }` );

	const parentFolderPath = `${ rootPath }/staging/jquery/${ version }`;
	const finalFolderPath = `${ parentFolderPath }/jquery-mobile`;
	const zipPath = `${ parentFolderPath }/jquery-mobile-${ version }.zip`;

	if ( existsSync( finalFolderPath ) ) {
		console.log( `Version ${ version } already downloaded, skipping.` );
		return;
	}

	await fs.mkdir( parentFolderPath, {
		recursive: true,
	} );

	await download(
		`https://github.com/jquery/jquery-mobile/archive/${ version }.zip`,
		zipPath
	);

	const zip = new AdmZip( zipPath );

	// The zip file contains a single folder named `jquery-mobile-${ version }`.
	// Extract it first to the parent path & rename to just "jquery-mobile".
	zip.extractAllTo( parentFolderPath, /* overwrite */ true );
	await fs.rename(
		`${ parentFolderPath }/jquery-mobile-${ version }`,
		finalFolderPath
	);

	await fs.unlink( zipPath );
};

const setupRepos = async () => new Promise( async ( resolve, reject ) => {
	console.log( " *** Set up the `repos` folder *** " );

	const jQueryMobileRepoParentPath = `${ rootPath }/repos/jquery`;
	const jQueryMobileRepoPath = `${ jQueryMobileRepoParentPath }/jquery-mobile.git`;

	if ( existsSync( jQueryMobileRepoPath ) ) {
		console.log( `jQuery Mobile repo already cloned, removing...` );
		await fs.rm( jQueryMobileRepoPath, {
			recursive: true
		} );
		console.log( `jQuery Mobile folder removed.` );
	}

	await fs.mkdir( jQueryMobileRepoParentPath, {
		recursive: true,
	} );

	console.log( "Cloning the jQuery Mobile repository..." );
	const gitProcess = spawn(
		"git clone --bare https://github.com/jquery/jquery-mobile.git",
		{
			shell: true,
			cwd: jQueryMobileRepoParentPath,
			pipe: 'inherit',
		}
	);

	gitProcess.on( "close", code => {
		if ( code === 0 ) {
			console.log( "Cloning finished successfully." );
			resolve();
		} else {
			process.exitCode = code;
			const message = `\`git clone\` child process exited with code ${ code }`;
			console.error( message );
			reject( new Error( message ) );
		}
	} );
} );

const setupStaging = async () => {
	console.log( " *** Set up the `staging` folder *** " );

	for ( const version of mobileVersions ) {
		await downloadVersion( version );
	}
};

const main = async () => {
	await setupRepos();
	await setupStaging();
} ;

main();

process.on( "unhandledRejection", ( reason ) => {
	process.exitCode = 1;
	throw reason;
} )
