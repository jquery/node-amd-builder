amd-builder
==========

This project aims at providing a Node.s service to build bundles out of AMD projects in a Git repository. This was developed for building jQuery Mobile bundles.
Initial checkout as well as workspace creation have to be done manually.

* Frontend: <https://jquerymobile.com/download-builder/>
* API instance: <https://amd-builder.jquerymobile.com/>

## API v1

### /v1/{project}/{repo}

Fetch the latest version of the repo from the default remote.

### /v1/{project}/{repo}/{ref}

Force checkout the ref into the {project}/{ref}/{repo} workspace if it exists.

### /v1/dependencies/{project}/{repo}/{ref}

Traces 1st level dependencies.

URL arguments are:

 - ```baseUrl```: The baseUrl for module name to file resolution
 - ```names```: An optional comma separated list of modules to include in the dependency map. If it's not specified, the service will compute the dependency map for all the .js files in the ```baseUrl``` directory.

### /v1/bundle/{project}/{repo}/{ref}/{name}?

```name``` is the name of the file generated it defaults to ```repo```.js

 1. ```name``` has extension .js (default) calls require.js to build the js bundle
 1. ```name``` has extension .css will resolve css dependencies through the ```//css:``` metadata and return a css bundle
 1. ```name``` has extension .zip will do all of the above in both optimize and non-optimized and return a zip file with 4 files in it

Builds a bundle for this repository's ref

URL arguments are:

 - ```baseUrl```: The baseUrl for module name to file resolution
 - ```include```: A comma separated list of modules to include in the bundle
 - ```exclude```: A comma separated list of modules to exclude from the bundle
 - ```optimize```: true or false

### Setup an instance for your project

Perform all the following operations in the `node-amd-builder` main folder.

1. Clone a bare repo of your project:
    ```
    mkdir repos
    cd repos
    git clone --bare git://github.com/yourname/yourproject.git
    ```

1. Now create the staging directory:
    ```
    mkdir -p staging
    ```

1. Install the dependencies with ```npm install```

1. Start the service:
    ```
    node server.js -r "$(pwd)/repos" -s "$(pwd)/staging"
    ```

1. Add a post_receive hook to the your GitHub repo pointing at ```http://instance:3000/post_receive```

### Setup an instance for jQuery Migrate

Perform all the following operations in the `node-amd-builder` main folder. Make sure you use Node.js v14.14.0 or higher.

1. Install the dependencies with `npm install`

1. Invoke:
    ```
    scripts/setup-mobile.js
    ```

1. Start the service:
    ```
    node server.js -r "$(pwd)/repos" -s "$(pwd)/staging"
    ```
    Invoke just `node server.js --help` to see other available options.

1. ~~Add a post_receive hook to the your GitHub repo pointing at `http://instance:3000/post_receive`~~ (only needed if you don't checkout tags manually as described above)

## Author

* Ghislain Seguin - [@gseguin](http://twitter.com/gseguin)

[![endorse](http://api.coderwall.com/ghislain/endorse.png)](http://coderwall.com/ghislain)

## Credits

Thanks to:

* [Jive Software](https://jivesoftware.com) - my employer - for letting me work on cool projects like this
