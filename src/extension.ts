'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
let fzfTerminal: vscode.Terminal | undefined = undefined;
let fzfTerminalPwd: vscode.Terminal | undefined = undefined;

let codeCmd: string;
let codePath: string;
let findCmd: string;
let fzfCmd: string;
let initialCwd: string;
let rgCaseFlag: string;
let fzfPipe: string;
let fzfPipeBatch: string;

export const TERMINAL_NAME = "fzf terminal";
export const TERMINAL_NAME_PWD = "fzf pwd terminal";

export enum rgoptions {
	CaseSensitive = "Case sensitive",
	IgnoreCase = "Ignore case",
	SmartCase = "Smart case"
}

export const rgflagmap = new Map<string, string>([
	[rgoptions.CaseSensitive, "--case-sensitive"],
	[rgoptions.IgnoreCase, "--ignore-case"],
	[rgoptions.SmartCase, "--smart-case"]
]);

function showFzfTerminal(name: string, fzfTerminal: vscode.Terminal | undefined): vscode.Terminal {
	if (!fzfTerminal) {
		// Look for an existing terminal
		fzfTerminal = vscode.window.terminals.find((term) => { return term.name === name; });
	}
	if (!fzfTerminal) {
		// Create an fzf terminal
		if (!initialCwd && vscode.window.activeTextEditor) {
			initialCwd = path.dirname(vscode.window.activeTextEditor.document.fileName);
		}
		initialCwd = initialCwd || '';
		fzfTerminal = vscode.window.createTerminal({
			cwd: initialCwd,
			name: name
		});
	}
	fzfTerminal.show();
	return fzfTerminal;
}

function moveToPwd(term: vscode.Terminal) {
	if (vscode.window.activeTextEditor) {
		let cwd = path.dirname(vscode.window.activeTextEditor.document.fileName);
		term.sendText(`cd ${cwd}`);
	}
}

function xargsCmd() {
	if (process.platform === 'darwin') {
		return 'xargs -0';
	} else {
		return 'xargs -0 -r';
	}

}

function applyConfig() {
	fzfCmd = vscode.workspace.getConfiguration('fzf-quick-open').get('fuzzyCmd') as string ?? "fzf";
	findCmd = vscode.workspace.getConfiguration('fzf-quick-open').get('findDirectoriesCmd') as string;
	initialCwd = vscode.workspace.getConfiguration('fzf-quick-open').get('initialWorkingDirectory') as string;
	let rgopt = vscode.workspace.getConfiguration('fzf-quick-open').get('ripgrepSearchStyle') as string;
	rgCaseFlag = rgflagmap.get(rgopt) ?? "Case sensitive";
}

function isWindows() {
	return process.platform === 'win32';
}

function setupCodeCmd() {
	codePath = vscode.env.appName.toLowerCase().indexOf('insiders') !== -1 ? 'code-insiders' : 'code';
	// Go find the code executable if we can. This adds stability for when the user's shell
	// doesn't have the right code on the top of the path
	let binRoot = vscode.env.appRoot;
	let localPath = path.join(binRoot, '..', '..', 'bin');
	let remotePath = path.join(binRoot, 'bin');
	if (fs.existsSync(localPath)) {
		codePath = path.join(localPath, codePath);
	} else if (fs.existsSync(remotePath)) {
		codePath = path.join(remotePath, codePath);
	}
	codeCmd = `"${codePath}"`;
}

function getPath(arg: string, pwd: string): string | undefined {
	if (!path.isAbsolute(arg)) {
		arg = path.join(pwd, arg);
	}
	if (fs.existsSync(arg)) {
		return arg;
	} else {
		return undefined;
	}
}

function escapeWinPath(origPath: string) {
	return origPath.replace(/\\/g,'\\\\');
}

export function activate(context: vscode.ExtensionContext) {
	applyConfig();
	if (isWindows()) {
		let server = net.createServer((socket) => {
			socket.on('data', (data) => {
				let [cmd, pwd, arg] = data.toString().trim().split('$$');
				cmd = cmd.trim(); pwd = pwd.trim(); arg = arg.trim();
				if (arg === "") { return }
				if (cmd === 'open') {
					let filename = getPath(arg, pwd);
					if (!filename) { return }
					vscode.window.showTextDocument(vscode.Uri.file(filename));
				} else if (cmd === 'add') {
					let folder = getPath(arg, pwd);
					if (!folder) { return }
					vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0, null, {
						uri: vscode.Uri.file(folder)
					});
					vscode.commands.executeCommand('workbench.view.explorer');
				} else if (cmd === 'rg') {
					let [file, linestr, colstr] = arg.split(':');
					let filename = getPath(file, pwd);
					if (!filename) { return };
					let line = parseInt(linestr)-1;
					let col = parseInt(colstr)-1;
					vscode.window.showTextDocument(vscode.Uri.file(filename)).then((ed) => {
						ed.selection = new vscode.Selection(line, col, line, col);
					})
				}
			})

		});
		let idx = 0;
		while (!fzfPipe) {
			try {
				let pipe = `\\\\?\\pipe\\fzf-pipe-${process.pid}`;
				if (idx > 0) { pipe += `-${idx}`; }
				server.listen(pipe);
				fzfPipe = escapeWinPath(pipe);
			} catch(e) {
				if (e.code === 'EADDRINUSE') {
					// Try again for a new address
					++idx;
				} else {
					// Bad news
					throw e;
				}
			}
		}
		fzfPipeBatch = vscode.extensions.getExtension('rlivings39.fzf-quick-open')?.extensionPath ?? "";
		fzfPipeBatch = escapeWinPath(path.join(fzfPipeBatch, 'scripts', 'topipe.bat'));
	}
	setupCodeCmd();
	vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration('fzf-quick-open')) {
			applyConfig();
		}
	})

	let codeOpenFileCmd = `${fzfCmd} | ${fzfPipeBatch} open ${fzfPipe}`;
	let codeOpenFolderCmd = `${fzfCmd} | ${fzfPipeBatch} add ${fzfPipe}`;

	context.subscriptions.push(vscode.commands.registerCommand('fzf-quick-open.runFzfFile', () => {
		let term = showFzfTerminal(TERMINAL_NAME, fzfTerminal);
		term.sendText(codeOpenFileCmd, true);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fzf-quick-open.runFzfFilePwd', () => {
		let term = showFzfTerminal(TERMINAL_NAME_PWD, fzfTerminalPwd);
		moveToPwd(term);
		term.sendText(codeOpenFileCmd, true);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fzf-quick-open.runFzfAddWorkspaceFolder', () => {
		let term = showFzfTerminal(TERMINAL_NAME, fzfTerminal);
		term.sendText(`${findCmd} | ${codeOpenFolderCmd}`, true);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fzf-quick-open.runFzfAddWorkspaceFolderPwd', () => {
		let term = showFzfTerminal(TERMINAL_NAME_PWD, fzfTerminalPwd);
		moveToPwd(term);
		term.sendText(`${findCmd} | ${codeOpenFolderCmd}`, true);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fzf-quick-open.runFzfSearch', async () => {
		let pattern = await getSearchText();
		if (pattern === undefined) {
			return;
		}
		let term = showFzfTerminal(TERMINAL_NAME, fzfTerminal);
		term.sendText(makeSearchCmd(pattern, codeCmd), true);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fzf-quick-open.runFzfSearchPwd', async () => {
		let pattern = await getSearchText();
		if (pattern === undefined) {
			return;
		}
		let term = showFzfTerminal(TERMINAL_NAME_PWD, fzfTerminalPwd);
		moveToPwd(term);
		term.sendText(makeSearchCmd(pattern, codeCmd), true);
	}));

	vscode.window.onDidCloseTerminal((terminal) => {
		switch (terminal.name) {
			case TERMINAL_NAME:
				fzfTerminal = undefined;
				break;

			case TERMINAL_NAME_PWD:
				fzfTerminalPwd = undefined
				break;
		}
	});
}

async function getSearchText(): Promise<string | undefined> {
	let activeSelection = vscode.window.activeTextEditor?.selection;
	let value: string | undefined = undefined;

	if (activeSelection) {
		let activeRange: vscode.Range | undefined;
		if (activeSelection.isEmpty) {
			activeRange = vscode.window.activeTextEditor?.document.getWordRangeAtPosition(activeSelection.active);
		} else {
			activeRange = activeSelection;
		}
		value = activeRange ? vscode.window.activeTextEditor?.document.getText(activeRange) : undefined
	}

	let pattern = await vscode.window.showInputBox({
		prompt: "Search pattern",
		value: value
	});
	return pattern;
}

/**
 * Return the command used to invoke rg. Exported to allow unit testing.
 * @param pattern Pattern to search for
 * @param codeCmd Command used to launch code
 */
export function makeSearchCmd(pattern: string, codeCmd: string): string {
	return `rg '${pattern}' ${rgCaseFlag} --vimgrep --color ansi | ${fzfCmd} --ansi | ${fzfPipeBatch} rg ${fzfPipe}`;
}
