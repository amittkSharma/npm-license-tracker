# npm-license-tracker
npm-license-tracker will track all the npm dependencies and their corrosponding licenses.
The module will generate the JSON file with all meta information about npm packages and copy corrosponding license files in a directory named "npm_licenses". This new folder will be created under the same project directory.

#Features
<ul>
  <li>Creation of JSON file with meta information about licenses</li>
  <li>Copying license files</li>
  <li>Creation of CSV file with meta information for Audit purpose</li>
</ul>

## Updates
| Date				      | Author			      | Description							|
| ----------------- | ----------------- | ----------- |
| 2017-09-24		  	| AmittK		        | Module to track npm dependencies with all meta information and license files. |

## Installing via Npm

```
npm install -g npm-license-tracker
```

## Usage
- Install the module using: npm install -g npm-license-tracker
- On command line, execute the command: npm-tracker "Path to package.json"
- To generate CSV, execute the command: npm-tracker "Path to package.json" true || false (<em>default value is false </em>)

## Example of license JSON so produced by app
![Alt text](https://github.com/amittkSharma/npm-license-tracker/blob/master/images/license_json.PNG?raw=true "npm packages meta information")



