const vscode = require('vscode');
const ch = require('child_process');
const fs = require('fs');
const path = require('path');

class Iar {

    constructor(path, project, config, folder) {
        this.path = path;
        this.project = project;
        this.config = config;
        this.folder = folder;
        this.errors = -1;
        this.warnings = -1;
        this.terminal = undefined;
        this.problems = [];
        this.commands = [];
        this.includes = [];
        this.defines = [];
        this.browse = [];
        this.projectname = '';
    }

    arg_replacer(match, p1) {
        var newstring = '"' + p1 + '" -';
        return newstring;
    }

    build_database_args(cmd) {
        cmd += " --predef_macros"
        var next = 1;
        var arg_fixed = cmd.replace(/([a-zA-Z]:\\[\\\S|*\S].*?)\s-/gm, this.arg_replacer);
        var regex = /'.*?'|".*?"|\S+/g;
        var args = ['--IDE3', '--NCG'];
        var temp;
        while (temp = regex.exec(arg_fixed)) {
            var string = temp[0];
            if (string == '-o') {
                next = 0;
            }
            else {
                if (next !== 0) {
                    args.push(string.split('"').join(''));
                }
                else {
                    next = 1;
                }
            }
        }
        return args;
    }

    build_database_single(cmd, inc, def) {
        var args = this.build_database_args(cmd);
        var defs;
        var tmpfile = this.folder + "/.vscode/iar.tmp";
        args.push(tmpfile);
        var spw = ch.spawnSync(this.path + "arm\\bin\\iccarm.exe", args);
        var temp;
        var inc_regex = new RegExp("^(\\$\\$TOOL_BEGIN\\s\\$\\$VERSION\\s\"3\"\\s\\$\\$INC_BEGIN\\s\\$\\$FILEPATH\\s\")(.*?)(\"\\s\\$\\$TOOL_END\\s)$", "gm");
        var buf = spw.output.toString();
        while (temp = inc_regex.exec(buf)) {
            inc.push(temp[2].split("\\\\").join("\\"));
        }

        if (fs.existsSync(tmpfile)) {
            def.push("__intrinsic =");
            def.push("__nounwind =");
            def.push("__noretrun =");
            defs = fs.readFileSync(tmpfile).toString();
            var def_regex = new RegExp("^(#define\\s)([^\\s]+\\s)(.*)$", "gm");
            while (temp = def_regex.exec(defs)) {
                def.push(temp[2] + '=' + temp[3]);
            }
            fs.unlinkSync(tmpfile);
        }
    }

    build_database() {
        var i = 0;
        for (var i = 0, icc_len = this.commands.length; i < icc_len; i++) {
            var inc = [];
            var def = [];
            var command = this.commands[i][1] + " " + this.commands[i][2]
            this.build_database_single(command, inc, def);
            for (var j = 0, inc_len = inc.length; j < inc_len; j++) {
                var tmp = path.normalize(inc[j]);
                if (this.includes.indexOf(tmp) < 0)
                    this.includes.push(path.normalize(tmp));
            }
            for (var j = 0, def_len = def.length; j < def_len; j++) {
                if (this.defines.indexOf(def[j]) < 0)
                    this.defines.push(def[j]);
            }
        }
    }

    parse_build_output(build_output) {
        var temp;

        //Check specific error or warning
        var problem_regex = new RegExp("^(.*)(Warning|Error|Fatal Error)\\[.*\\]:\\s(.*)$", "gm");
        while (temp = problem_regex.exec(build_output)) {
            this.problems.push(temp);
        }

        var problem_regex = new RegExp("^(.*)(ERROR,).*$", "gm");
        while (temp = problem_regex.exec(build_output)) {
            this.problems.push(temp);
        }

        var problem_regex = new RegExp("^(.*)(Configuration is up).*$", "gm");
        while (temp = problem_regex.exec(build_output)) {
            this.problems.push(temp);
        }

        //Check total errors
        var error_regex = new RegExp("^Total number of errors: (\\d+)$", "gm");
        var error_regex_result = error_regex.exec(build_output);
        if (error_regex_result) {
            this.errors = error_regex_result[1];
        }

        //Check total warnings
        var warning_regex = new RegExp("^Total number of warnings: (\\d+)$", "gm");
        var warning_regex_result = warning_regex.exec(build_output);
        if (warning_regex_result) {
            this.warnings = warning_regex_result[1];
        }

        //Check compile commands:
        var icc_regex = new RegExp("^iccarm.exe (.*\\.c) (.*)$", "gm");
        while (temp = icc_regex.exec(build_output)) {
            this.commands.push(temp);
        }
    }

    build_database_config() {
        if (this.defines.length > 0 || this.includes.length > 0) {

            for (var i = 0, len = this.includes.length; i < len; i++) {
                if (this.browse.indexOf(this.includes[i]) < 0)
                    this.browse.push(this.includes[i]);
            }

            var name = this.folder + '\\.vscode\\c_cpp_properties.json';
            var browse_config = {
                path: this.browse,
                limitSymbolsToIncludedHeaders: true,
                databaseFilename: ".vscode/browse.db"
            }

            var iar_config = {
                name: "IAR",
                intelliSenseMode: "clang-x64",
                browse: browse_config,
                includePath: this.includes,
                defines: this.defines
            }

            var properties = {
                version: 3,
                configurations: [iar_config]
            }

            if (fs.existsSync(name)) {
                fs.unlinkSync(name);
            }
            fs.writeFileSync(name, JSON.stringify(properties, null, 4));
        }
    }

    parse_project() {
        if (fs.existsSync(this.project)) {
            var temp;
            var buffer = fs.readFileSync(this.project);
            var filetag = [];
            var regex = new RegExp("<file>[\\s\\S]*?<name>([\\s\\S]*?)<\\/name>[\\s\\S]*?<\\/file>", "gm");
            var proj_dir = path.dirname(this.project);
            while (temp = regex.exec(buffer)) {
                var browsedir = path.dirname(path.normalize(temp[1].replace("$PROJ_DIR$", proj_dir))) + "\\";
                if (this.browse.indexOf(browsedir) < 0)
                    this.browse.push(browsedir);
            }
        }
    }

    build() {

        var iar = this;

        this.parse_project();

        iar.terminal = vscode.window.createOutputChannel('IAR');
        iar.terminal.show();

        iar.terminal.appendLine('Building configuration: ' + iar.config);

        var args = [iar.project.split("\\").join("\\\\"), iar.config, '-log', 'all'];
        var out = ch.spawn(iar.path + "common\\bin\\IarBuild.exe", args, { detached: true });
        var build_output = '';

        out.stdout.on('data', function (data) {
            var buffer = data.toString();
            var temp;
            var regex = new RegExp("^iccarm.exe (.*\\.c) (.*)$", "gmi");
            while (temp = regex.exec(buffer)) {
                iar.terminal.appendLine(path.basename(temp[1]));
            }
            var regex = new RegExp("^iasmarm.exe (.*\\.s) (.*)$", "gmi");
            while (temp = regex.exec(buffer)) {
                iar.terminal.appendLine(path.basename(temp[1]));
            }
            build_output += buffer;
        });

        out.on('close', function (code) {
            iar.parse_build_output(build_output);

            if (iar.problems.length > 0) {
                iar.terminal.appendLine(' ');
                for (var i = 0, len = iar.problems.length; i < len; i++) {
                    iar.terminal.appendLine(iar.problems[i][0]);
                }
            }

            iar.build_database();
            iar.build_database_config();
            iar.terminal.appendLine(' ');

            vscode.workspace.problems

            if (iar.errors >= 0)
                iar.terminal.appendLine('Errors: ' + iar.errors);
            if (iar.warnings >= 0)
                iar.terminal.appendLine('Warning: ' + iar.warnings);
        })
    }
}

module.exports = Iar;