const { join } = require('node:path');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const {
    Client,
    MessageEmbed,
    // MessageActionRow,
    // MessageButton,
} = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const {
    AudioPlayerStatus,
    createAudioPlayer,
    createAudioResource,
    joinVoiceChannel,
    VoiceConnectionStatus,
} = require('@discordjs/voice');
const ytsr = require('ytsr');
const ytdl = require('ytdl-core');
const { token, clientId, guildId = '' } = require('./config.json');

const sleep = require('node:util').promisify(setTimeout);
let client;
try {
    client = new Client({ intents: [
        // GUILDS
        1,
        // GUILD_VOICE_STATES
        1 << 7,
        // GUILD_MEMBERS (Privileged)
        1 << 1,
    ] });
} catch {
    throw '請開啟GUILD_MEMBERS intent';
}

// client.setMaxListeners(Infinity);

// Database
class DB {
    static getInstance(...args) {
        if (!this.instance) this.instance = new this(...args);
        return this.instance;
    }

    /**
     * @param {string} dbPath
     */
    constructor(dbPath) {
        this.path = dbPath;
        this.read();
    }

    read() {
        this.data = JSON.parse(readFileSync(this.path, { encoding: 'utf-8' }));
    }

    write() {
        writeFileSync(this.path, JSON.stringify(this.data), { encoding: 'utf-8' });
    }
}
const dataPath = join(__dirname, 'data.json');
if (!existsSync(dataPath)) writeFileSync(dataPath, '{"dvc":{},"welcome":{},"ms":{}}', { encoding: 'utf-8' });
const db = DB.getInstance(dataPath);

// Slash

class CommandsManager {
    static getInstance(...args) {
        if (!this.instance) this.instance = new this(...args);
        return this.instance;
    }

    /* eslint-disable no-shadow */

    /**
     * @param {{
     *     token: string;
     *     clientId: string;
     *     guildId: ?string;
     * }}
     */
    constructor({
        token,
        clientId,
        guildId,
    }) {
        /**
         * @type {string}
         */
        this.token = token;
        /**
         * @type {string}
         */
        this.clientId = clientId;
        /**
         * @type {boolean}
         */
        this.global = !guildId;
        if (!this.global) {
            /**
             * @type {?string}
             */
            this.guildId = guildId;
        }
        /**
         * @type {SlashCommandBuilder[]}
         */
        this.cmds = [];
    }

    /* eslint-enable no-shadow */

    /**
     * @typedef {object} Arg
     * @property {string} name
     * @property {'Boolean' | 'Channel' | 'Integer' | 'Mentionable' | 'Number' | 'Role' | 'String' | 'User'} type
     * @property {string} description
     * @property {?boolean} required
     */

    /**
     * @typedef {Arg[]} ArgsData
     */

    /**
     * @typedef {object} CommandData
     * @property {string} name
     * @property {string} description
     * @property {?ArgsData} args
     * @property {?((cmd: import('discord.js').CommandInteraction) => *)} action
     */

    /**
     * @param {CommandData}
     */
    add({
        name,
        description,
        args = [],
        action,
    }) {
        const cmd = new SlashCommandBuilder;
        cmd.setName(name);
        cmd.setDescription(description);
        args.forEach(arg => {
            cmd[`add${arg.type}Option`](op => op
                .setName(arg.name)
                .setDescription(arg.description)
                .setRequired(arg.required ?? false));
        });
        this.cmds.push(cmd);
        if (action) client.on('interactionCreate', async cmd => { // eslint-disable-line no-shadow
            if (!cmd.isCommand()) return;
            if (cmd.commandName !== name) return;
            if (!cmd.guild) return cmd.reply('指令必須在伺服器內使用喔');
            try {
                await action(cmd);
            } catch (e) { console.log(e); }
        });
    }

    async register() {
        const rest = new REST({ version: '9' }).setToken(this.token);
        const route =
            this.global
                ? Routes.applicationCommands(this.clientId)
                : Routes.applicationGuildCommands(this.clientId, this.guildId);
        await rest.put(route, { body: this.cmds.map(c => c.toJSON()) });
        console.log('成功註冊斜線指令');
    }
}

const commandsManager = CommandsManager.getInstance({ token, clientId, guildId });

// DVC

commandsManager.add({
    name: 'dvc',
    description: '在伺服器中新增動態語音頻道',
    args: [
        {
            name: 'name',
            description: '要建立的類別名稱',
            type: 'String',
            required: false,
        },
    ],
    async action(cmd) {
        if (!cmd.memberPermissions.has('MANAGE_CHANNELS')) return cmd.reply({
            embeds: [
                new MessageEmbed()
                    .setColor('RED')
                    .setTitle('沒有權限')
                    .setDescription('你需要管理頻道權限才可使用此指令'),
            ],
        });
        if (!cmd.guild.members.cache.get(clientId).permissions.has('MANAGE_CHANNELS')) return cmd.reply({
            embeds: [
                new MessageEmbed()
                    .setColor('RED')
                    .setTitle('沒有權限')
                    .setDescription('機器人需要管理頻道權限才可使用此指令'),
            ],
        });
        const { id: catId } = await cmd.guild.channels.create(
            cmd.options.getString('name') ?? '動態語音頻道',
            { type: 'GUILD_CATEGORY' },
        );
        if (!db.data.dvc[cmd.guild.id]) db.data.dvc[cmd.guild.id] = {};
        db.data.dvc[cmd.guild.id].category = catId;
        const { id: channelId } = await cmd.guild.channels.create(
            '點我創建語音頻道',
            {
                type: 'GUILD_VOICE',
                parent: catId,
                userLimit: 1,
            },
        );
        db.data.dvc[cmd.guild.id].channel = channelId;
        db.data.dvc[cmd.guild.id].created = [];
        db.write();
        cmd.reply(`<#${channelId}>`);
    },
});

client.on('voiceStateUpdate', async (_, new_) => {
    if (!new_.channel) return;
    if (new_.guild.id in db.data.dvc && db.data.dvc[new_.guild.id].channel === new_.channel.id) {
        const { id } = await new_.guild.channels.create(
            `${new_.member.user.username}的頻道`,
            {
                type: 'GUILD_VOICE',
                parent: db.data.dvc[new_.guild.id].category,
            },
        );
        db.data.dvc[new_.guild.id].created.push(id);
        new_.setChannel(id);
        db.write();
    }
});

client.on('voiceStateUpdate', (old, new_) => {
    if (!old.channel || old.channel === new_.channel) return;
    if (old.channel.members.size === 0 && db.data.dvc[old.guild.id]?.created.includes(old.channel.id)) {
        db.data.dvc[old.guild.id].created.splice(db.data.dvc[old.guild.id].created.indexOf(old.channel.id), 1);
        old.channel.delete();
        db.write();
    }
});

// Welcome

commandsManager.add({
    name: 'set-welcome',
    description: '設定歡迎頻道',
    args: [{
        name: 'channel',
        description: '要設定的歡迎頻道',
        type: 'Channel',
        required: true,
    }],
    action(cmd) {
        /** @type {import('discord.js').GuildBasedChannel} */
        const channel = cmd.options.getChannel('channel');
        if (!channel.permissionsFor(cmd.member).has('SEND_MESSAGES') || !cmd.memberPermissions.has('MODERATE_MEMBERS')) return cmd.reply({
            embeds: [
                new MessageEmbed()
                    .setColor('RED')
                    .setTitle('沒有權限')
                    .setDescription('你需要管理成員及在該頻道發送訊息的權限才可使用此指令'),
            ],
        });
        if (!channel.permissionsFor(cmd.guild.members.cache.get(clientId)).has('SEND_MESSAGES')) return cmd.reply({
            embeds: [
                new MessageEmbed()
                    .setColor('RED')
                    .setTitle('沒有權限')
                    .setDescription('機器人在該頻道發送訊息的權限才可使用此指令'),
            ],
        });
        db.data.welcome[cmd.guild.id] = channel.id;
        db.write();
        cmd.reply('成功設定');
    },
});

client.on('guildMemberAdd', async member => {
    if (!(member.guild.id in db.data.welcome)) return;
    try {
        await member.guild.channels.cache.get(db.data.welcome[member.guild.id]).send(`恭喜${member.user.tag}成為${member.guild.name}的第${member.guild.memberCount}位成員！`);
    } catch (e) {
        console.log(e);
    }
});

// Member count

commandsManager.add({
    name: 'member-count',
    description: '顯示伺服器人數',
    action(cmd) {
        cmd.reply(`伺服器內有${cmd.guild.memberCount}人！`);
    },
});

// BAN

commandsManager.add({
    name: 'ban',
    description: '停權成員',
    args: [{
        name: 'member',
        description: '要停權的成員',
        type: 'User',
        required: true,
    }],
    action(cmd) {
        const user = cmd.options.getUser('member');
        const name = user.username;
        if (!cmd.memberPermissions.has('BAN_MEMBERS')) return cmd.reply({
            embeds: [
                new MessageEmbed()
                    .setColor('RED')
                    .setTitle('沒有權限')
                    .setDescription('你需要停權成員的權限才可使用此指令'),
            ],
        });
        try {
            cmd.guild.members.ban(user);
            cmd.reply(`成功停權${name}`);
        } catch {
            cmd.reply(`無法停權${name}`);
        }
    },
});

// Delete Message
commandsManager.add({
    name: 'delete',
    description: '刪除這個頻道中的訊息',
    args: [{
        name: 'count',
        description: '要刪除的數量(預設為1)',
        type: 'Integer',
    }],
    async action(cmd) {
        /** @type {import('discord.js').TextBasedChannel} */
        const channel = cmd.channel;
        if (!channel.permissionsFor(cmd.member).has('MANAGE_MESSAGE')) return cmd.reply({
            embeds: [
                new MessageEmbed()
                    .setColor('RED')
                    .setTitle('沒有權限')
                    .setDescription('你需要在此頻道管理訊息的權限才可使用此指令'),
            ],
        });
        try {
            await channel.bulkDelete(cmd.options.getInteger('count') ?? 1);
            const msg = await cmd.reply({ content: '成功刪除指定訊息', fetchReply: true });
            await sleep(2000);
            await msg.delete();
        } catch {
            cmd.reply('無法刪除所有訊息');
        }
    },
});

// Music (From nk980113/music-bot, whose logic is from B-l-u-e-b-e-r-r-y/Discord-Bot-02)

class MusicCenter {
    /* eslint-disable no-shadow */
    constructor(client) {
        this.client = client;
        this.isPlaying = {};
        this.isPaused = {};
        this.connections = {};
        this.players = {};
        this.queue = {};
    }

    static getInstance(client) {
        if (!this.instance)
            this.instance = new MusicCenter(client);
        return this.instance;
    }
    joinChannel(cmd) {
        const member = cmd.member;
        if (!member)
            return false;
        const { channel } = member.voice;
        if (!channel)
            return false;
        this.connections[channel.guild.id] = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
        });
        return true;
    }
    leaveChannel(guildId) {
        try {
            const player = this.players[guildId];
            if (player) {
                player.removeAllListeners();
                player.stop();
                delete this.players[guildId];
            }
            const connection = this.connections[guildId];
            connection.destroy();
            delete this.connections[guildId];
            if (this.queue[guildId])
                delete this.queue[guildId];
            this.isPlaying[guildId] = false;
            this.isPaused[guildId] = false;
            return true;
        } catch {
            return false;
        }
    }
    async searchYT(kw) {
        try {
            const res = await ytsr(kw);
            const result = res.items
                .filter(i => i.type === 'video');
            return result.map(v => ({
                title: v.title,
                id: v.url.replace('https://www.youtube.com/watch?v=', ''),
                duration: v.duration,
            }));
        } catch {
            return null;
        }
    }
    async addSong(id, guildId) {
        try {
            const songUrl = `https://www.youtube.com/watch?v=${id}`;
            const res = await ytdl.getInfo(songUrl);
            const { title } = res.videoDetails;
            if (!this.queue[guildId])
                this.queue[guildId] = [];
            this.queue[guildId].push({
                title,
                songUrl,
            });
            return [true, title];
        } catch {
            return [false, ''];
        }
    }
    play(cmd, guildId) {
        const { channel } = cmd;
        if (!channel)
            return cmd.followUp('找不到給我發訊息的頻道，嗚嗚...');
        if (this.queue[guildId].length === 0)
            return channel.send('好像沒有歌給我播呢...');
        this.isPlaying[guildId] = true;
        const player = this.players[guildId] = createAudioPlayer();
        this.connections[guildId].subscribe(player);
        const play = () => {
            const song = this.queue[guildId].shift();
            if (!song)
                return;
            const audioStream = ytdl(song.songUrl, { filter: 'audioonly' });
            const audioResource = createAudioResource(audioStream);
            player.play(audioResource);
            player.once(AudioPlayerStatus.Playing, () => {
                channel.send(`正在播放：${song.title}`);
            });
            player.once(AudioPlayerStatus.Idle, () => {
                if (this.queue[guildId].length > 0)
                    play();
                else {
                    channel.send('好像沒有歌可以播了...');
                    this.isPlaying[guildId] = false;
                }
            });
        };
        play();
    }
    pause(guildId) {
        const succeed = this.players[guildId].pause();
        this.isPaused[guildId] = succeed;
        return succeed;
    }
    resume(guildId) {
        const succeed = this.players[guildId].unpause();
        this.isPaused[guildId] = !succeed;
        return succeed;
    }
    skip(cmd, guildId) {
        const player = this.players[guildId];
        player.removeAllListeners();
        player.stop();
        this.play(cmd, guildId);
    }
    getQueue(guildId) {
        return this.queue[guildId].map((s, i) => `\`[${i + 1}]\` ${s.title}`).join('\n');
    }
    setup(client = this.client) {
        client.on('interactionCreate', async (cmd) => {
            await (async () => {
                if (!cmd.isCommand())
                    return;
                if (!cmd.guild)
                    return cmd.reply('這台機器人只能在伺服器內使用！');
                switch (cmd.commandName) {
                    case 'join': {
                        if (this.connections[cmd.guild.id])
                            return cmd.reply('你沒看到我人已經在裡面了嗎？');
                        const succeed = this.joinChannel(cmd);
                        if (!succeed)
                            return cmd.reply('你有加入語音頻道嗎？');
                        this.connections[cmd.guild.id].on(VoiceConnectionStatus.Ready, () => {
                            cmd.reply('成功加入語音頻道');
                        });
                        break;
                    }
                    case 'leave': {
                        if (!this.connections[cmd.guild.id])
                            return cmd.reply('...正在離開不存在的頻道...');
                        const succeed = this.leaveChannel(cmd.guild.id);
                        if (!succeed)
                            return cmd.reply('這東西怪怪的...');
                        cmd.reply('成功離開語音頻道');
                        break;
                    }
                    case 'search': {
                        const kw = cmd.options.getString('kw', true);
                        const res = await this.searchYT(kw);
                        if (!res)
                            return cmd.reply('尷尬，出了點問題');
                        const embed = new MessageEmbed()
                            .setColor('RED')
                            .setTitle(`搜尋結果：${kw}`);
                        res.filter((_, i) => i < 25).forEach(v => {
                            embed.addField(v.title, `${v.duration ? `${v.duration}  ` : ''}${v.id}`);
                        });
                        cmd.reply({ embeds: [embed] });
                        break;
                    }
                    case 'add': {
                        if (!this.connections[cmd.guild.id])
                            return cmd.reply('先讓我加入語音頻道再說啦！');
                        const videoId = cmd.options.getString('id', true);
                        const [succeed, title] = await this.addSong(videoId, cmd.guild.id);
                        if (!succeed)
                            cmd.reply('好像怪怪的...你確定有這首歌嗎？');
                        else
                            cmd.reply(`成功將${title}加入歌曲清單`);
                        break;
                    }
                    case 'play': {
                        if (!this.connections[cmd.guild.id])
                            return cmd.reply('先讓我加入語音頻道再說啦！');
                        if (this.isPlaying[cmd.guild.id])
                            return cmd.reply('已經在播放歌曲了啦！');
                        cmd.reply('正在進行播放程序...');
                        this.play(cmd, cmd.guild.id);
                        break;
                    }
                    case 'pause': {
                        if (!this.isPlaying[cmd.guild.id])
                            return cmd.reply('...正在暫停不存在的歌曲...');
                        if (this.isPaused[cmd.guild.id])
                            return cmd.reply('這首歌已經被暫停了啦！');
                        if (this.pause(cmd.guild.id))
                            cmd.reply('成功暫停歌曲');
                        else
                            cmd.reply('不行...這捲錄音帶自戀到無法自拔的地步...');
                        break;
                    }
                    case 'resume': {
                        if (!this.isPaused[cmd.guild.id])
                            return cmd.reply('等等...歌沒有被暫停啊？還是你根本沒有放歌？');
                        if (this.resume(cmd.guild.id))
                            cmd.reply('繼續播放');
                        else
                            cmd.reply('錄音帶掉入萬丈深淵，等待救援中...');
                        break;
                    }
                    case 'skip': {
                        if (!this.isPlaying[cmd.guild.id])
                            return cmd.reply('意義上，沒有歌在播好像不能跳...');
                        if (this.isPaused[cmd.guild.id])
                            return cmd.reply('請先繼續播放音樂，不然播放器會壞掉...');
                        this.skip(cmd, cmd.guild.id);
                        break;
                    }
                    case 'queue': {
                        if (!this.queue[cmd.guild.id])
                            return cmd.reply('你確定這有東西嗎？');
                        cmd.reply(this.getQueue(cmd.guild.id));
                        break;
                    }
                }
            })();
        });
    }

    /* eslint-enable no-shadow */
}

const musicCenter = MusicCenter.getInstance(client);
musicCenter.setup();

commandsManager.add({
    name: 'join',
    description: '讓機器人加入語音頻道',
});

commandsManager.add({
    name: 'leave',
    description: '讓機器人離開語音頻道並清空歌曲清單',
});

commandsManager.add({
    name: 'search',
    description: '顯示在YouTube搜尋到的前25個結果',
    args: [{
        name: 'kw',
        description: '要搜尋的項目',
        type: 'String',
        required: true,
    }],
});

commandsManager.add({
    name: 'add',
    description: '在歌曲清單中新增歌曲',
    args: [{
        name: 'id',
        description: '歌曲網址後面那串，記得別再加 https://www.youtube.com/ 之類的東西了',
        type: 'String',
        required: true,
    }],
});

commandsManager.add({
    name: 'play',
    description: '播放歌曲清單中的歌曲',
});

commandsManager.add({
    name: 'pause',
    description: '暫停歌曲',
});

commandsManager.add({
    name: 'resume',
    description: '繼續播放歌曲',
});

commandsManager.add({
    name: 'skip',
    description: '跳過目前歌曲',
});

commandsManager.add({
    name: 'queue',
    description: '查看目前歌曲清單',
});

// Mine Sweeper

/*
commandsManager.add({
    name: 'mine-sweeper',
    description: '在頻道中玩踩地雷',
    action(cmd) {
        let gameId = 0;
        while (gameId in db.data.ms) gameId++;
        const gameBoard = new Array(8).fill(new Array(8));
        const randNum = [];
        for (let i = 63; i > 55; i--) randNum.push(Math.floor(Math.random() * i));
        randNum.forEach(n => {
            gameBoard[Math.floor(n / 8)][n % 8] = 1;
        });
        cmd.reply({
            embeds: [
                new MessageEmbed()
                    .setColor('GREY')
                    .setTitle('踩地雷')
                    .setDescription(''
                        + '🟩🟦🟦🟦🟦🟦🟦🟦\n'
                        + '🟦🟦🟦🟦🟦🟦🟦🟦\n'.repeat(6)
                        + '🟦🟦🟦🟦🟦🟦🟦🟦'),
            ],
            components: [
                new MessageActionRow()
                    .addComponents(
                        new MessageButton()
                            .setStyle('PRIMARY')
                            .setEmoji('◀')
                            .setCustomId(`${cmd.member.id} `),
                    ),
            ],
        });
    },
});
*/


// When Ready
client.once('ready', () => {
    client.user.setPresence({ activities: [{ name: '左邊那顆月亮好大但不圓', type: 'WATCHING' }], status: 'idle' });
    console.log(`以${client.user.tag}身分登入`);
    commandsManager.register();
});

client.login(token);