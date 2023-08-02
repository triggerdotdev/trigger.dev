import fetch from "node-fetch";
import inquirer from "inquirer";
import semver from "semver";
import { readFileSync } from 'fs';
import { logger } from "../utils/logger.js";
import { getUserPkgManager } from "../utils/getUserPkgManager.js";
import { exec } from "child_process";
import { installDependencies } from "../utils/installDependencies.js";
import { resolvePath } from "../utils/parseNameAndPath.js";
import { writeJSONFile } from "../utils/fileSystem.js";
import pathModule from "path";

export async function updateCommand(path: string) {
    try {
        const resolvedPath = resolvePath(path);
        const installedPackages = await getInstalledPackages(resolvedPath);
        const triggerDevPackagesName = Object.keys(installedPackages.dependencies).filter(pkg => pkg.startsWith('@trigger.dev/'));

        if (triggerDevPackagesName.length === 0) {
            logger.info('No @trigger.dev packages found in package.json.');
            return;
        }

        const triggerDevPackagesVersions = Object.fromEntries(triggerDevPackagesName.map(packageName => {
            const currentVersion = installedPackages.dependencies[packageName].version;
            return [packageName, currentVersion];
        }));

        const latestVersions = await getLatestVersions(triggerDevPackagesName, triggerDevPackagesVersions);
        const updates: { [packageName: string]: string } = {};

        triggerDevPackagesName.forEach(packageName => {
            const currentVersion = installedPackages.dependencies[packageName].version;
            const latestVersion = latestVersions[packageName];
            if (latestVersion) {
                if (semver.gt(latestVersion, currentVersion)) {
                    updates[packageName] = latestVersion;
                }
            }
        });


        if (Object.keys(updates).length === 0) {
            console.log('No updates available.');
            return;
        }

        const confirm = await confirmUpdate(updates);

        if (confirm) {
            const updatedPackageJson = updatePackageJson(updates);
            await writeJSONFile(pathModule.join(resolvedPath, 'package.json'), updatedPackageJson);
            logger.info('package.json updated.');

            // Run 'npm install' to install the updated packages
            await installDependencies(resolvedPath);
        } else {
            logger.info('Update canceled.');
        }
    } catch (error) {
        logger.error('An error occurred:', error);
    }
}

async function getInstalledPackages(resolvedPath: string): Promise<any> {
    const manager = getUserPkgManager();
    return new Promise((resolve, reject) => {
        exec(`${manager} list --depth=0 --json`, {
            cwd: resolvedPath
        }, (error, stdout) => {
            if (error) {
                reject(error);
            } else {
                const installedPackages = JSON.parse(stdout.toString());
                switch (manager) {
                    case "npm":
                        resolve(installedPackages);
                        break;
                    case "yarn":
                        resolve(convertYarnOutput(installedPackages));
                        break;
                    case "pnpm":
                        resolve(convertPnpmOutput(installedPackages));
                        break;
                }
            }
        });
    });
}

function convertPnpmOutput(pnpmOutput: any[]): any {
    const rootProject = pnpmOutput[0];
    if (rootProject && rootProject.dependencies) {
        const dependencies: { [name: string]: { version: string } } = {};
        for (const [name, details] of Object.entries(rootProject.dependencies)) {
            dependencies[name] = { version: (details as any).version };
        }
        return { dependencies };
    }

    return {};
}

function convertYarnOutput(yarnOutput: any): any {
    const packages: { [name: string]: { version: string } } = {};

    for (const pkg of yarnOutput.data.trees) {
        if (pkg.name) {
            const [name, version] = pkg.name.split('@');
            if (name && version) {
                packages[name] = { version };
            }
        }
    }

    return { dependencies: packages };
}

async function getLatestVersions(packageNames: string[], packageVersion: { [name: string]: string}): Promise<{ [packageName: string]: string }> {
    const registryUrl = 'https://registry.npmjs.org';

    const requests = packageNames.map(packageName =>
        fetch(`${registryUrl}/${packageName}`, {
            method: "GET",
            headers: {
                'Accept-Encoding': 'application/json',
            },
        })
    );

    const responses = await Promise.all(requests);
    const responseData: any[] = await Promise.all(responses.map(res => res.json()));

    return responseData.reduce((versions: { [packageName: string]: string }, response, index) => {
        const packageName = packageNames[index];
        if (packageName) {
            const isUsingNext = packageVersion[packageName]?.includes("next");
            const nextVersion = response['dist-tags']?.next;
            const latestVersion = response['dist-tags'].latest;

            if (isUsingNext && nextVersion && semver.gt(nextVersion, latestVersion)) {
                versions[packageName] = nextVersion;
            } else {
                versions[packageName] = latestVersion;
            }
        }
        return versions;
    }, {});
}

function updatePackageJson(updates: { [packageName: string]: string }) {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

    Object.entries(updates).forEach(([packageName, version]) => {
        packageJson.dependencies[packageName] = `^${version}`;
    });

    return packageJson;
}

async function confirmUpdate(updates: { [packageName: string]: string }) {
    logger.info('The following updates are available:');
    console.table(updates);

    const { confirm } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'confirm',
            message: 'Do you want to update the packages?'
        }
    ]);

    return confirm;
}
