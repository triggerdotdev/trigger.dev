import axios from "axios";
import inquirer from "inquirer";
import semver from "semver";
import { readFileSync } from 'fs';
import { logger } from "../utils/logger.js";
import { getUserPkgManager } from "../utils/getUserPkgManager.js";
import { execSync } from "child_process";
import { installDependencies } from "../utils/installDependencies.js";
import { resolvePath } from "../utils/parseNameAndPath.js";
import { writeJSONFile } from "../utils/fileSystem.js";

export async function updateCommand(path: string) {
    try {
        const resolvedPath = resolvePath(path);
        const installedPackages = getInstalledPackages();
        const triggerDevPackages = Object.keys(installedPackages.dependencies).filter(pkg => pkg.startsWith('axios'));

        if (triggerDevPackages.length === 0) {
            logger.info('No @trigger.dev packages found in package.json.');
            return;
        }

        const latestVersions = await getLatestVersions(triggerDevPackages);
        const updates: { [packageName: string]: string } = {};

        triggerDevPackages.forEach(packageName => {
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

function getInstalledPackages(): any {
    const manager = getUserPkgManager();
    const installedPackages = JSON.parse(execSync(`${manager} list --depth=0 --json`).toString());
    return installedPackages;
}

async function getLatestVersions(packageNames: string[]): Promise<{ [packageName: string]: string }> {
    const registryUrl = 'https://registry.npmjs.org';

    const requests = packageNames.map(packageName =>
        axios.get(`${registryUrl}/${packageName}`)
    );

    const responses = await Promise.all(requests);
    return responses.reduce((versions: { [packageName: string]: string }, response, index) => {
        const packageName = packageNames[index];
        if (packageName) {
            const latestVersion = response.data['dist-tags'].latest;
            versions[packageName] = latestVersion;
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
