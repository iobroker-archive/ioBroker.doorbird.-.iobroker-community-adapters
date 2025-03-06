'use strict';

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

const dgram = require('node:dgram');
const Axios = require('axios').default;
Axios.defaults.timeout = 5000;
const http = require('node:http');
const udpserver = dgram.createSocket('udp4');

const InterimSolutionForDeletionOfDuplicates = false;
const MAX_SCHEDULES = 200;
let COUNT_SCHEDULES = 0;

let adapterStarted = false;

class Doorbird extends utils.Adapter {
    /**
     * @param [options]
     */
    constructor(options) {
        super({
            ...options,
            name: 'doorbird',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.sockets = [];
        this.bellCount = 0;
        this.scheduleState = {};
        this.motionState = {};
        this.doorbellsArray = []; // Contains all Doorbell IDs
        this.favoriteState = {}; // {'ID of Doorbell/Motion/RFID': 'ID of Favorite'}

        this.authorized = false;

        this.wizard = false;
        this.wizardTimeout = null;
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Reset the connection indicator during startup
        await this.setState('info.connection', { val: false, ack: true });

        await Promise.all([this.migrateAsync(), this.mainAsync()]);
    }

    async mainAsync() {
        if (this.config.birdip && this.config.birdpw && this.config.birduser) {
            this.testBirdAsync(); // no await because code should run parallel
        }

        try {
            udpserver.on('listening', () => {
                const address = udpserver.address();
                this.log.debug(`Adapter listening on IP: ${address} - UDP Port 35344`);
            });
        } catch (error) {
            this.log.error(`address already in use ${this.config.adapterAddress}:${this.config.adapterport}: ${error}`);
        }

        // udpserver.bind(35344);
        if (this.config.adapterAddress) {
            try {
                this.server = http.createServer(async (req, res) => {
                    if (res.socket && res.socket.remoteAddress) {
                        const remoteAddress = res.socket.remoteAddress.replace(/^.*:/, '');
                        if (remoteAddress === this.config.birdip) {
                            res.writeHead(204, { 'Content-Type': 'text/plain' });
                            if (req.url == '/motion') {
                                this.log.debug('Received Motion-alert from Doorbird!');
                                await Promise.all([
                                    this.setState('Motion.trigger', { val: true, ack: true }),
                                    this.downloadFileAsync('Motion'),
                                ]);

                                this.setTimeout(async () => {
                                    await this.setState('Motion.trigger', { val: false, ack: true });
                                }, 2500);
                            }
                            if (req.url && req.url.indexOf('ring') != -1) {
                                const id = req.url.substring(req.url.indexOf('?') + 1, req.url.length);
                                this.log.debug(`Received Ring-alert (ID: ${id}) from Doorbird!`);
                                await Promise.all([
                                    this.setState(`Doorbell.${id}.trigger`, { val: true, ack: true }),
                                    this.downloadFileAsync(`Doorbell${id}`),
                                ]);

                                this.setTimeout(async () => {
                                    await this.setState(`Doorbell.${id}.trigger`, { val: false, ack: true });
                                }, 2000);
                            }
                            res.end();
                        }
                    } else {
                        res.writeHead(401, { 'Content-Type': 'text/plain' });
                        res.end();
                    }
                });

                this.server.listen(this.config.adapterport || 8081, this.config.adapterAddress, () => {
                    this.log.debug(
                        `Server started on port ${this.config.adapterport || 8100} with IP ${this.config.adapterAddress}`,
                    );
                });
            } catch (e) {
                this.log.warn(`There was an Error starting the HTTP Server! (${e})`);
            }
        } else {
            this.log.warn('You need to set the Adapteraddress in the Instance-Settings!!');
        }

        this.subscribeStates('*');
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param id
     * @param state
     */
    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        const comp = id.split('.');

        if (!this.authorized) {
            this.log.warn('Cannot do that because not authorized! Check you config!');
            return;
        }

        switch (comp[2]) {
            case 'Restart':
                this.log.debug('Trying to restart DoorBird Device..');
                await this.restartDoorbirdAsync();
                break;
            case 'TakeSnapshot':
                this.log.info('Trying to take snapshot..');
                await this.downloadFileAsync('TakeSnapshot');
                break;
            case 'Light':
                this.log.info('Trying to turn on light..');
                await this.turnOnLightAsync();
                break;
            case 'Relays':
                await this.relaysAsync(comp[3]);
                break;
        }
    }
    /**
     * @param obj
     */
    async onMessage(obj) {
        if (typeof obj === 'object' && obj.message) {
            if (obj.command === 'wizard' && !this.wizard) {
                this.startWizard(obj);
                this.wizard = true;
            }
        }
    }

    /**
     * @param key
     * @param value
     * @returns
     */
    decryption(key, value) {
        let result = '';
        for (let i = 0; i < value.length; ++i) {
            result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
        }
        return result;
    }

    /**
     * Generate URL
     *
     * @param command
     */
    buildURL(command) {
        return `http://${this.config.birdip}/bha-api/${command}.cgi?http-user=${this.config.birduser}&http-password=${
            this.config.birdpw
        }`;
    }

    /**
     * Check Doorbird Connection
     *
     * @async
     * @returns
     */
    async testBirdAsync() {
        try {
            const url = this.buildURL('schedule');
            const response = await Axios.get(url);

            if (response.status === 401) {
                this.authorized = false;
                await this.setState('info.connection', { val: false, ack: true });
                this.log.warn(`Whooops.. DoorBird says User ${this.config.birduser} is unauthorized!!`);
                this.log.warn('Check Username + Password and enable the "API-Operator" Permission for the User!!');
            } else if (response.status === 200) {
                this.authorized = true;
                await this.setState('info.connection', { val: true, ack: true });
                this.log.debug(`Authorization with User ${this.config.birduser} successful!`);
                if (!adapterStarted) {
                    adapterStarted = true;
                    await this.getInfoAsync();
                }
            }
        } catch (error) {
            if (error.code === 'EHOSTUNREACH') {
                this.authorized = false;
                await this.setState('info.connection', { val: false, ack: true });
                this.log.warn('DoorBird Device is offline!!');
            } else if (error.code === 'ECONNABORTED') {
                this.authorized = false;
                await this.setState('info.connection', { val: false, ack: true });
                this.log.warn(`Error in testBird() Request timed out: ${error}`);
            } else {
                this.authorized = false;
                await this.setState('info.connection', { val: false, ack: true });
                this.log.warn(`Error in testBird() Request: ${error}`);
            }
        }

        if (this.birdConCheck) {
            this.clearTimeout(this.birdConCheck);
            this.birdConCheck = null;
        }

        this.birdConCheck = this.setTimeout(async () => {
            this.log.debug(`Refresh connection check...`);
            this.birdConCheck = null;
            await this.testBirdAsync();
        }, 180000);
    }

    /**
     * Get Doorbird Info
     *
     * @async
     * @returns
     */
    async getInfoAsync() {
        if (this.authorized) {
            try {
                const url = this.buildURL('info');
                const response = await Axios.get(url);

                if (response.status === 200) {
                    const info = response.data;
                    await this.setState('info.firmware', { val: info.BHA.VERSION[0].FIRMWARE, ack: true });
                    await this.setState('info.build', { val: info.BHA.VERSION[0].BUILD_NUMBER, ack: true });
                    await this.setState('info.type', { val: info.BHA.VERSION[0]['DEVICE-TYPE'], ack: true });

                    const relays = info.BHA.VERSION[0].RELAYS;

                    for (const value of relays) {
                        //create channel
                        await this.createObjectsAsync('Relays', 'channel', {
                            name: {
                                en: 'Available Relays',
                                de: 'Verfügbare Relais',
                                ru: 'Доступные реле',
                                pt: 'Relés disponíveis',
                                nl: 'Available Relay',
                                fr: 'Relais disponibles',
                                it: 'Relè disponibili',
                                es: 'Relés disponibles',
                                pl: 'Dostępny Relay',
                                uk: 'Доступні реле',
                                'zh-cn': '现有费用',
                            },
                        });
                        //create State
                        await this.createObjectsAsync(`Relays.${value}`, 'state', {
                            name: {
                                en: 'Activate relay',
                                de: 'Relais aktivieren',
                                ru: 'Активировать реле',
                                pt: 'Activar o relé',
                                nl: 'Activeer relay',
                                fr: 'Activer le relais',
                                it: 'Attiva relè',
                                es: 'Activar el relé',
                                pl: 'Aktywacja',
                                uk: 'Активувати реле',
                                'zh-cn': '法 律 法 律 律 律 律 律 律 律 律 律 律 律 律 律 律 律 律 律 律 律 重',
                            },
                            type: 'boolean',
                            role: 'button',
                            read: false,
                            write: true,
                            desc: `ID: ${value}`,
                        });
                    }
                }
            } catch (error) {
                this.log.warn(`Error in getInfo(): ${error}`);
            }

            await this.checkFavoritesAsync();
        } else {
            this.log.warn('Execution of getInfo not allowed because not authorized!');
        }
    }

    /**
     * Check Favorites
     *
     * @async
     * @returns
     */
    async checkFavoritesAsync() {
        this.log.debug('Checking favorites on DoorBird Device..');
        try {
            const url = this.buildURL('favorites');
            const response = await Axios.get(url);

            if (response.status === 200) {
                const favorites = response.data;
                if (!favorites.http || typeof favorites.http !== 'object') {
                    this.log.warn('It seems that the list of HTTP Favorites is empty!');
                    await this.createFavoritesAsync(0);
                    return;
                }
                for (const [key, obj] of Object.entries(favorites.http)) {
                    if (
                        obj.title.includes(`ioBroker ${this.namespace}`) &&
                        !obj.value.includes(`${this.config.adapterAddress}:${this.config.adapterport}`)
                    ) {
                        this.log.warn(
                            `The Favorite ID '${key}' contains a wrong URL ('${obj.value}').. I will update that..`,
                        );

                        await this.updateFavoriteAsync(key, obj);
                        return;
                    }

                    if (obj.value.includes(`${this.config.adapterAddress}:${this.config.adapterport}`)) {
                        this.log.debug(
                            `Found a Favorite that belongs to me.. (ID: '${key}') ('${obj.title}': '${obj.value}')`,
                        );

                        const favoriteKey = obj.title.split(' ')[2];
                        const favoriteUrl = obj.value;

                        this.favoriteState[favoriteKey] = {
                            ID: key,
                            URL: obj.value,
                        };

                        const duplicate = Object.values(this.favoriteState).find(
                            item => item.URL === favoriteUrl && item.ID !== key,
                        );

                        if (duplicate) {
                            this.log.warn(`Found a duplicate favorite! (ID : '${key}') URL ${obj.value}`);

                            if (InterimSolutionForDeletionOfDuplicates) {
                                this.log.warn(
                                    `deleting duplicates is currently in dev-mode. Please delete duplicates yourself via the Doorbird app if necessary.`,
                                );
                            } else {
                                this.log.debug(`Trying to delete the duplicate..`);

                                const deleteUrl = `http://${this.config.birdip}/bha-api/favorites.cgi?http-user=${this.config.birduser}&http-password=${this.config.birdpw}&action=remove&type=http&id=${key}`;

                                try {
                                    const deleteResponse = await Axios.get(deleteUrl);

                                    if (deleteResponse.status === 200) {
                                        delete this.favoriteState[favoriteKey];
                                        this.log.debug(`Deleted the duplicate (ID: '${key}') successfully!`);
                                        // toDelete
                                        this.log.debug(`favoriteState: ${JSON.stringify(this.favoriteState)}`);
                                    } else {
                                        this.log.warn(`I was unable to delete the duplicate! (ID: ${key})`);
                                    }
                                } catch (error) {
                                    this.log.error(
                                        `An error occurred while trying to delete the duplicate (ID: ${key}): ${error}`,
                                    );
                                }
                            }
                        }
                    }
                }

                if (Object.keys(this.favoriteState).length === 0) {
                    this.log.debug('I did not find any Favorite on the DoorBird Device that belongs to me.');
                } else {
                    this.log.debug(`Result of Favorites: ${JSON.stringify(this.favoriteState)}`);
                }

                await this.getSchedulesAsync();
                return;
            }
        } catch (error) {
            this.log.warn(`Error in checkFavoritesAsync(): ${error}`);
        }
    }

    /**
     * Update Favorites
     *
     * @async
     * @param key
     * @param obj
     * @returns
     */
    async updateFavoriteAsync(key, obj) {
        const newURL = obj.value.replace(
            /(http:\/\/)(.*)(\/.*)/,
            `$1${this.config.adapterAddress}:${this.config.adapterport}$3`,
        );

        try {
            const url = `http://${this.config.birdip}/bha-api/favorites.cgi?http-user=${
                this.config.birduser
            }&http-password=${this.config.birdpw}&action=save&type=http&id=${key}&title=${obj.title}&value=${newURL}`;

            const response = await Axios.get(url);

            if (response.status === 200) {
                this.log.debug('Favorite Updated successfully..');
                await this.checkFavoritesAsync();
            } else {
                this.log.warn(`There was an error while updating the Favorite! ${response.status}`);
            }
        } catch (error) {
            if (error.code === 'ECONNABORTED') {
                this.log.warn(`Error in testBird() Request timed out: ${error}`);
            } else {
                this.log.warn(`There was an error while updating the Favorite! (${error})`);
            }
        }
    }

    /**
     * Get Schedules
     *
     * @async
     * @returns
     */
    async getSchedulesAsync() {
        this.log.debug(`[ getSchedulesAsync ] Schedule call count: ${COUNT_SCHEDULES}`);
        COUNT_SCHEDULES++;

        try {
            const url = this.buildURL('schedule');
            const response = await Axios.get(url);

            if (response.status === 200) {
                try {
                    const schedules = response.data;
                    this.bellCount = 0;
                    this.log.debug(`Following schedules found: ${JSON.stringify(schedules)}`);
                    this.log.debug('Looping through the Schedules..');

                    for (let i = 0; i < schedules.length && i < MAX_SCHEDULES; i++) {
                        if (schedules[i].input === 'doorbell') {
                            this.bellCount++;
                            this.log.debug('Detected a Doorbell Schedule!');
                            this.scheduleState[schedules[i].param] = schedules[i].output;
                            this.log.debug(`The Param of the actual Schedule is: ${schedules[i].param}`);
                            this.doorbellsArray.push(schedules[i].param);
                            this.log.debug(`The Output contains ${schedules[i].output.length} entries!`);

                            for (let k = 0; k < schedules[i].output.length; k++) {
                                this.log.debug(`Entry "${k}" is: ${JSON.stringify(schedules[i].output[k])}`);
                            }

                            this.log.debug(`Counted ${this.bellCount} Doorbells.`);
                        }

                        if (schedules[i].input === 'motion') {
                            this.log.debug('Detected Motion Schedule!');
                            this.motionState.output = schedules[i].output;
                            this.log.debug(`The Output contains ${schedules[i].output.length} entries!`);

                            for (let k = 0; k < schedules[i].output.length; k++) {
                                this.log.debug(`Entry "${k}" is: ${JSON.stringify(schedules[i].output[k])}`);
                            }
                        }
                    }

                    await this.createFavoritesAsync(0);
                } catch (error) {
                    this.log.warn(`Error in Parsing Schedules: ${error}. Error-Stack: ${error.stack}`);
                }
            }
        } catch (error) {
            this.log.warn(`Error in getSchedules(): ${error}`);
        }
    }

    /**
     * @async
     * @param i
     * @param [action]
     * @param [motion]
     * @returns
     */
    async createFavoritesAsync(i, action, motion) {
        this.log.debug('Checking if we need to create any favorites..');
        if (i < this.doorbellsArray.length && !motion) {
            this.log.debug(`Cheking if Favorite for Doorbell ID ${this.doorbellsArray[i]} exists.`);
            if (this.favoriteState[this.doorbellsArray[i]]) {
                this.log.debug(`Favorite for Doorbell ID ${this.doorbellsArray[i]} exists!`);
                i++;
                await this.createFavoritesAsync(i, false, false);
                return;
            }
            try {
                this.log.debug(`Favorite for Doorbell ID ${this.doorbellsArray[i]} has to be created!`);
                const createUrl = `http://${this.config.birdip}/bha-api/favorites.cgi?http-user=${
                    this.config.birduser
                }&http-password=${this.config.birdpw}&action=save&type=http&title=ioBroker ${this.namespace} ${
                    this.doorbellsArray[i]
                } Ring&value=http://${this.config.adapterAddress}:${this.config.adapterport}/ring?${
                    this.doorbellsArray[i]
                }`;
                const response = await Axios.get(createUrl);

                if (response.status === 200) {
                    i++;
                    this.log.debug(`Favorite created successfully..`);
                    await this.createFavoritesAsync(i, true, false);
                    return;
                }
            } catch (error) {
                this.log.warn(`Error in creating Favorite: ${error}`);
            }
        }
        if (typeof this.favoriteState['Motion'] === 'undefined' && !motion) {
            try {
                const url = `http://${this.config.birdip}/bha-api/favorites.cgi?http-user=${
                    this.config.birduser
                }&http-password=${this.config.birdpw}&action=save&type=http&title=ioBroker ${
                    this.namespace
                } Motion&value=http://${this.config.adapterAddress}:${this.config.adapterport}/motion`;

                const response = await Axios.get(url);

                if (response.status === 200) {
                    this.log.debug('Favorite for Motionsensor created.');
                    await this.createFavoritesAsync(i, true, true);
                    return;
                }
            } catch (error) {
                this.log.warn(`Error creating favorite for Motionsensor: ${error}`);
                return;
            }
        }
        if (action) {
            this.log.debug('Finished creating Favorites.. Checking again - just to be sure!');
            //toDelete
            this.log.debug(`favoriteState before check again: ${JSON.stringify(this.favoriteState)}`);
            await this.checkFavoritesAsync();
        } else {
            this.log.debug('Favorites checked successfully. No actions needed!');
            await this.createSchedulesAsync();
        }
    }

    /**
     * Create Schedules
     *
     * @async
     * @returns
     */
    async createSchedulesAsync() {
        this.log.debug('Checking if we need to create Schedules on DoorBird Device..');

        for (const key of Object.keys(this.scheduleState)) {
            let actionNeeded = true;
            for (let i = 0; i < this.scheduleState[key].length; i++) {
                if (this.scheduleState[key][i].event !== 'http') {
                    continue;
                }
                if (this.scheduleState[key][i].param === this.favoriteState[key]['ID']) {
                    actionNeeded = false;
                }
            }

            if (actionNeeded) {
                this.log.debug(`We need to create a Schedule for Doorbell ID: ${key}`);
                const scheduleArray = this.scheduleState[key];
                scheduleArray.push({
                    event: 'http',
                    param: this.favoriteState[key]['ID'],
                    enabled: '1',
                    schedule: { weekdays: [{ from: '79200', to: '79199' }] },
                });

                this.toCreate = { input: 'doorbell', param: key, output: scheduleArray };

                try {
                    const createUrl = this.buildURL('schedule');
                    const response = await Axios.post(createUrl, this.toCreate);

                    if (response.status === 200) {
                        this.log.debug('Schedule created successfully!');
                    } else {
                        this.log.warn(
                            `There was an Error while creating the schedule. Status: ${response.status}, Text: ${response.statusText}`,
                        );
                    }
                } catch (error) {
                    this.log.warn(`Error in creating schedule: ${error}`);
                }
            } else {
                this.log.debug('Okay we dont need to create any Doorbell-Schedules..');
            }
        }

        for (const value of this.doorbellsArray) {
            await this.createObjectsAsync(`Doorbell.${value}`, 'device', {
                name: {
                    en: 'Doorbell',
                    de: 'Türklingel',
                    // ...
                },
                desc: `ID: ${value}`,
            });

            // create State
            await this.createObjectsAsync(`Doorbell.${value}.trigger`, 'state', {
                role: 'indicator',
                name: `Doorbell ID '${value}' pressed`,
                type: 'boolean',
                read: true,
                write: false,
                def: false,
            });
        }

        await this.createMotionScheduleAsync();
    }

    /**
     * Create Motion Schedule
     *
     * @async
     * @returns
     */
    async createMotionScheduleAsync() {
        for (const key of Object.keys(this.motionState)) {
            let actionNeeded = true;
            for (let i = 0; i < this.motionState[key].length; i++) {
                if (this.motionState[key][i].event !== 'http') {
                    continue;
                }
                if (this.motionState[key][i].param === this.favoriteState['Motion']['ID']) {
                    actionNeeded = false;
                }
            }

            if (actionNeeded) {
                this.log.debug('We need to create a Schedule for the Motion Sensor!');
                const motionArray = this.motionState[key];
                motionArray.push({
                    event: 'http',
                    param: this.favoriteState['Motion']['ID'],
                    enabled: '1',
                    schedule: { weekdays: [{ from: '79200', to: '79199' }] },
                });

                const toCreate = { input: 'motion', param: '', output: motionArray };

                try {
                    const createUrl = this.buildURL('schedule');
                    const response = await Axios.post(createUrl, toCreate);

                    if (response.status === 200) {
                        this.log.debug('Schedule for Motion Sensor set successfully!');
                    } else {
                        this.log.warn(
                            `There was an Error while setting the Motion schedule. (Statuscode: ${response.status}), (Statustext: ${response.statusText}`,
                        );
                    }
                } catch (error) {
                    this.log.warn(`Error in setting Motion schedule: ${error}`);
                }
            }
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback
     */
    onUnload(callback) {
        try {
            this.setState('info.connection', { val: false, ack: true });

            if (this.birdConCheck) {
                this.clearTimeout(this.birdConCheck);
                this.birdConCheck = null;
            }
            if (this.server) {
                this.server.close(() => {
                    this.log.debug(`Server closed`);
                });
            }
            for (let i = 0; i < this.sockets.length; i++) {
                this.sockets[i].destroy();
            }
            this.sockets = [];
            callback();
        } catch (error) {
            this.log.error(`Error in onUnload: ${error}`);
            callback();
        }
    }

    /**
     * Wizard to find Doorbird
     *
     * @async
     * @param msg
     */
    async startWizard(msg) {
        this.wizard = true;
        const wizServer = dgram.createSocket('udp4');

        wizServer.on('listening', () => {
            const address = wizServer.address();
            this.log.debug(`Wizard listening on IP: ${address.address} - UDP Port 6524`);
        });

        wizServer.on('message', (message, remote) => {
            const text = message.toString('utf-8');
            this.log.debug(`Wizard received message [${message.length}]: ${remote.address}: ${text}`);

            if (remote.address && message.includes(':')) {
                const parts = text.split(':', 3); // e.g. 847:jxazqm:1741003295

                this.sendTo(
                    msg.from,
                    msg.command,
                    {
                        native: {
                            birdip: remote.address,
                            birdid: parts[1],
                        },
                        saveConfig: true,
                        error: null,
                    },
                    msg.callback,
                );

                this.wizard = false;
                (() => {
                    if (this.wizardTimeout) {
                        this.clearTimeout(this.wizardTimeout);
                        this.wizardTimeout = null;
                    }
                })();
                if (this.wizardTimeout) {
                    this.clearTimeout(this.wizardTimeout);
                }
                wizServer.close();
            }
        });

        wizServer.bind(6524);

        if (this.wizardTimeout) {
            this.clearTimeout(this.wizardTimeout);
        }
        this.wizardTimeout = this.setTimeout(() => {
            wizServer.close();
            this.wizard = false;

            this.sendTo(
                msg.from,
                msg.command,
                {
                    error: 'timeout',
                },
                msg.callback,
            );

            this.log.debug('Wizard timeout!');
        }, 60000);
    }

    /**
     * Turn on light
     *
     * @async
     */
    async turnOnLightAsync() {
        try {
            const url = this.buildURL('light-on');
            const response = await Axios.get(url);

            if (response.status === 200) {
                this.log.debug('Light successfully triggered!');
            } else {
                this.log.warn(`Could not trigger light. (Got Statuscode ${response.status})`);
            }
        } catch (error) {
            this.log.warn(`Error in triggering Light: ${error}`);
        }
    }

    /**
     * Restart Doorbird
     *
     * @async
     */
    async restartDoorbirdAsync() {
        try {
            const url = this.buildURL('restart');
            const response = await Axios.get(url);

            if (response.status === 200) {
                this.log.debug('DoorBird Device is now restarting!!');
            } else if (response.status === 503) {
                this.log.warn('DoorBird denied restart! (Device is busy and cannot restart now!)');
            } else {
                this.log.warn(`DoorBird denied restart! (Statuscode: ${response.status})`);
            }
        } catch (error) {
            this.log.warn(`DoorBird denied restart: ${error}`);
        }
    }

    /**
     * Trigger Relays
     *
     * @async
     * @param comp
     */
    async relaysAsync(comp) {
        try {
            const url = `http://${this.config.birdip}/bha-api/open-door.cgi?http-user=${
                this.config.birduser
            }&http-password=${this.config.birdpw}&r=${comp}`;

            const response = await Axios.get(url);

            if (response.status === 200) {
                this.log.debug(`Relay ${comp} triggered successfully!`);
            } else if (response.status === 204) {
                this.log.warn(`Could not trigger relay ${comp}! (Insufficient permissions)`);
            } else {
                this.log.warn(`Could not trigger relay ${comp}. (Got Statuscode ${response.status})`);
            }
        } catch (error) {
            this.log.warn(`Error in triggering Relay: ${error}`);
        }
    }

    /**
     * Download File from Doorbird
     *
     * @async
     * @param cmd
     */
    async downloadFileAsync(cmd) {
        try {
            const url = this.buildURL('image');
            const response = await Axios.get(url, { responseType: 'stream' });
            const chunks = [];

            response.data.on('data', chunk => {
                chunks.push(chunk);
            });

            response.data.on('end', async () => {
                const fileData = Buffer.concat(chunks);
                await this.writeFileAsync(this.namespace, `${cmd}_1.jpg`, fileData);
                this.log.debug('Snapshot saved successfully!');
            });
        } catch (error) {
            this.log.warn(`Error in downloading file: ${error}`);
        }
    }

    /**
     * Create datapoint and update datapoints
     *
     * @async
     * @param dp path to datapoint
     * @param type type of object
     * @param common common part of object
     * @param [foreign] set adapter states = false; set foreign states = true
     */
    async createObjectsAsync(dp, type, common, foreign) {
        const obj = !foreign ? await this.getObjectAsync(dp) : await this.getForeignObjectAsync(dp);

        if (!obj) {
            const obj = {
                _id: dp,
                type: type,
                common: common,
                native: {},
            };
            await (foreign ? this.setForeignObjectAsync(dp, obj) : this.setObjectAsync(dp, obj));
            this.log.debug(`Object: ${dp} created.`);
        } else {
            if (JSON.stringify(obj.common) !== JSON.stringify(common) || !('native' in obj)) {
                obj.common = common;
                obj.native = obj.native ?? {};
                await (foreign ? this.setForeignObjectAsync(dp, obj) : this.setObjectAsync(dp, obj));
                this.log.debug(`Object: ${dp} updated.`);
            }
        }
    }

    /**
     * Migrate versions above 1.0.1
     *
     * @async
     */
    async migrateAsync() {
        try {
            let migrate = false;
            const arrayOfStates = await this.getStatesOfAsync();
            for (const obj of arrayOfStates) {
                if (obj._id.includes('.snapshot') && obj.type === 'state') {
                    await this.delObjectAsync(obj._id);
                    migrate = true;
                }
            }
            if (migrate) {
                this.log.info(`Version migrated. Snapshot states deleted.`);
            }
        } catch (error) {
            this.log.warn(`Error on migrate. Error: ${error}`);
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param [options]
     */
    module.exports = options => new Doorbird(options);
} else {
    // otherwise start the instance directly
    new Doorbird();
}
