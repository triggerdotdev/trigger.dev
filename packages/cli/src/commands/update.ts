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

export async function updateCommand(path: string) {
    try {
        const resolvedPath = resolvePath(path);
        const installedPackages = await getInstalledPackages();
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
            await writeJSONFile('package.json', updatedPackageJson);
            logger.info('package.json updated.');

            // Run 'npm install' to install the updated packages
            logger.info('Running npm install...');
            await installDependencies(resolvedPath);
            logger.info('Dependencies updated.');
        } else {
            logger.info('Update canceled.');
        }
    } catch (error) {
        logger.error('An error occurred:', error);
    }
}

async function getInstalledPackages(): Promise<any> {
    const manager = getUserPkgManager();
    return new Promise((resolve, reject) => {
        exec(`${manager} list --depth=0 --json`, (error, stdout) => {
            if (error) {
                reject(error);
            } else {
                const installedPackages = JSON.parse(stdout.toString());
                resolve(installedPackages);
            }
        });
    });
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
    logger.info(JSON.stringify(updates));
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
