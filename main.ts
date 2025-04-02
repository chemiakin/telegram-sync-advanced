import { App, Plugin, PluginSettingTab, Setting, Notice, TFile } from 'obsidian';
import TelegramBot from 'node-telegram-bot-api';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';

interface TelegramSyncSettings {
    telegramToken: string;
    allowedUsers: string[];
    useSeparator: boolean;
    useDailyNote: boolean;
    supportChats: boolean;
    separateChatNotes: boolean;
    sendDate: boolean;
    sendTime: boolean;
    sendUsername: boolean;
    downloadFiles: boolean;
    sendSuccessMessage: boolean;
    successMessageText: string;
    sendReaction: boolean;
    reactInChats: boolean;
}

const DEFAULT_SETTINGS: TelegramSyncSettings = {
    telegramToken: '',
    allowedUsers: [],
    useSeparator: false,
    useDailyNote: true,
    supportChats: false,
    separateChatNotes: false,
    sendDate: true,
    sendTime: true,
    sendUsername: true,
    downloadFiles: false,
    sendSuccessMessage: false,
    successMessageText: '✅ Note added',
    sendReaction: true,
    reactInChats: false,
};

export default class TelegramSyncPlugin extends Plugin {
    settings: TelegramSyncSettings = DEFAULT_SETTINGS;
    bot: TelegramBot | null = null;

    override async onload() {
        await this.loadSettings();
        this.addSettingTab(new TelegramSettingTab(this.app, this));

        if (this.settings.telegramToken) {
            this.connectToTelegram();
        }

        this.addCommand({
            id: 'sync-telegram-notes',
            name: 'Sync Telegram Notes',
            callback: () => this.syncMessages(),
        });
    }

    connectToTelegram() {
        try {
            this.bot = new TelegramBot(this.settings.telegramToken, { polling: true });
            const reactions = ['👌', '👍', '🎉', '🤨'];

            if (this.bot) {
                this.bot.on('message', async (msg: TelegramBot.Message) => {
                    const userId = msg.from?.id?.toString();
                    const username = msg.from?.username ? `@${msg.from.username}` : 'Unknown';
                    const chatId = msg.chat.id.toString();
                    const text = msg.text || '[No text]';
                    const date = new Date(msg.date * 1000);
                    const isChat = msg.chat.type !== 'private';

                    const isUserAllowed = this.settings.allowedUsers.length === 0 ||
                        (userId && this.settings.allowedUsers.includes(userId)) ||
                        (username !== 'Unknown' && this.settings.allowedUsers.includes(username));
                    const isAllowed = isUserAllowed && (!isChat || (isChat && this.settings.supportChats));

                    if (isAllowed) {
                        await this.appendToNote(msg, text, date, username, chatId, isChat);
                        if (this.bot) {
                            if (this.settings.sendSuccessMessage && (!isChat || !this.settings.reactInChats)) {
                                this.bot.sendMessage(chatId, this.settings.successMessageText, { reply_to_message_id: msg.message_id });
                            }
                            if (this.settings.sendReaction && (!isChat || this.settings.reactInChats)) {
                                const reaction = reactions[Math.floor(Math.random() * reactions.length)];
                                await (this.bot as any).setMessageReaction(chatId, msg.message_id, {
                                    reaction: [{ type: 'emoji', emoji: reaction }]
                                }).catch(() => {
                                    this.bot!.sendMessage(chatId, reaction, { reply_to_message_id: msg.message_id });
                                });
                            }
                        }
                    }
                });
            }

            new Notice('Connected to Telegram bot!');
        } catch (error) {
            new Notice('Error connecting to Telegram: ' + (error as Error).message);
        }
    }

    async syncMessages() {
        if (!this.bot) {
            new Notice('Please set up Telegram token first!');
            return;
        }
        new Notice('Messages are being synced in real-time.');
    }

    async appendToNote(msg: TelegramBot.Message, text: string, date: Date, username: string, chatId: string, isChat: boolean) {
        let fileName: string;
        if (isChat && this.settings.supportChats && this.settings.separateChatNotes) {
            fileName = `chat-${chatId}.md`;
        } else if (this.settings.useDailyNote) {
            const dateStr = date.toISOString().split('T')[0];
            fileName = `${dateStr}.md`;
        } else {
            fileName = `msg-${msg.message_id}.md`;
        }

        let timestamp = '';
        if (this.settings.sendDate && this.settings.sendTime) {
            timestamp = date.toLocaleString();
        } else if (this.settings.sendDate) {
            timestamp = date.toLocaleDateString();
        } else if (this.settings.sendTime) {
            timestamp = date.toLocaleTimeString();
        }

        let contentParts: string[] = [];
        if (timestamp) contentParts.push(`**${timestamp}**`);
        if (this.settings.sendUsername) contentParts.push(`(${username})`);
        contentParts.push(text);
        let content = contentParts.filter(Boolean).join(' ');

        if (this.settings.downloadFiles && (msg.photo || msg.document) && this.bot) {
            const file = msg.photo ? msg.photo[msg.photo.length - 1] : msg.document;
            if (file) {
                const fileUrl = await this.bot.getFileLink(file.file_id);
                const fileNameBase = msg.document && 'file_name' in msg.document ? msg.document.file_name : `telegram-${file.file_id}`;
                const fileExt = msg.photo ? '.jpg' : (path.extname(fileUrl) || '.bin');
                const fileName = `${fileNameBase}${fileExt}`;
                const filePath = path.join((this.app.vault.adapter as any).getBasePath(), fileName);

                await new Promise<void>((resolve, reject) => {
                    https.get(fileUrl, (response) => {
                        const fileStream = fs.createWriteStream(filePath);
                        response.pipe(fileStream);
                        fileStream.on('finish', () => {
                            fileStream.close();
                            resolve();
                        });
                        fileStream.on('error', reject);
                    }).on('error', reject);
                });

                content += `\n![[${fileName}]]`;
            }
        }

        content += '\n';
        if (this.settings.useSeparator) content += '<hr>\n';

        const file = this.app.vault.getAbstractFileByPath(fileName);
        if (file && file instanceof TFile) {
            const existingContent = await this.app.vault.read(file);
            await this.app.vault.modify(file, existingContent + content);
        } else {
            const header = (this.settings.useDailyNote || (isChat && !this.settings.separateChatNotes)) ? `# ${fileName.replace('.md', '')}\n\n` : '';
            await this.app.vault.create(fileName, header + content);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        if (!this.settings.supportChats) this.settings.separateChatNotes = false;
    }

    async saveSettings() {
        if (!this.settings.supportChats) this.settings.separateChatNotes = false;
        await this.saveData(this.settings);
    }

    override onunload() {
        if (this.bot) {
            this.bot.stopPolling();
        }
    }
}

class TelegramSettingTab extends PluginSettingTab {
    plugin: TelegramSyncPlugin;

    constructor(app: App, plugin: TelegramSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Telegram Bot Token')
            .setDesc('Enter your Telegram bot token from BotFather.')
            .addText((text) =>
                text
                    .setPlaceholder('123456:ABC-DEF...')
                    .setValue(this.plugin.settings.telegramToken)
                    .onChange(async (value: string) => {
                        this.plugin.settings.telegramToken = value;
                        await this.plugin.saveSettings();
                        this.plugin.connectToTelegram();
                    })
            );

        new Setting(containerEl)
            .setName('Allowed Users')
            .setDesc('Comma-separated Telegram usernames (e.g., @username) or IDs (leave empty to allow all).')
            .addText((text) =>
                text
                    .setPlaceholder('@user1, 12345, @user2')
                    .setValue(this.plugin.settings.allowedUsers.join(', '))
                    .onChange(async (value: string) => {
                        this.plugin.settings.allowedUsers = value
                            .split(',')
                            .map((id: string) => id.trim())
                            .filter(Boolean);
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Use Separator')
            .setDesc('Add a horizontal line between messages.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.useSeparator)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.useSeparator = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Use Daily Note')
            .setDesc('Append personal messages to a daily note.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.useDailyNote)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.useDailyNote = value;
                        await this.plugin.saveSettings();
                    })
            );

        const chatSupportSetting = new Setting(containerEl)
            .setName('Support Telegram Chats')
            .setDesc('Allow messages from groups and channels.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.supportChats)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.supportChats = value;
                        if (!value) this.plugin.settings.separateChatNotes = false;
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        const separateChatSetting = new Setting(containerEl)
            .setName('Separate Chat Notes')
            .setDesc('Each chat gets its own permanent note.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.separateChatNotes)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.separateChatNotes = value;
                        await this.plugin.saveSettings();
                    })
            );
        separateChatSetting.settingEl.style.opacity = this.plugin.settings.supportChats ? '1' : '0.5';
        separateChatSetting.components.forEach(comp => comp.setDisabled(!this.plugin.settings.supportChats));

        containerEl.createEl('h3', { text: 'Incoming Message Settings' });

        new Setting(containerEl)
            .setName('Send Date')
            .setDesc('Include the date in messages.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.sendDate)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.sendDate = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Send Time')
            .setDesc('Include the time in messages.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.sendTime)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.sendTime = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Send Username')
            .setDesc('Include the Telegram username.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.sendUsername)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.sendUsername = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Download Files')
            .setDesc('Download files and images to Obsidian.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.downloadFiles)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.downloadFiles = value;
                        await this.plugin.saveSettings();
                    })
            );

        containerEl.createEl('h3', { text: 'Reactions on Messages' });

        const successMessageSetting = new Setting(containerEl)
            .setName('Send Success Message')
            .setDesc('Send a message when a note is added (not in chats if reactions are enabled).')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.sendSuccessMessage)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.sendSuccessMessage = value;
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        new Setting(containerEl)
            .setName('Success Message Text')
            .setDesc('Text to send when a note is added.')
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.successMessageText)
                    .onChange(async (value: string) => {
                        this.plugin.settings.successMessageText = value || '✅ Note added';
                        await this.plugin.saveSettings();
                    })
            )
            .setDisabled(!this.plugin.settings.sendSuccessMessage);

        new Setting(containerEl)
            .setName('Send Reaction')
            .setDesc('Set a random reaction (👌👍🎉🤨) instead of a message.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.sendReaction)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.sendReaction = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('React in Chats')
            .setDesc('Set reactions in group chats instead of messages.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.reactInChats)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.reactInChats = value;
                        await this.plugin.saveSettings();
                    })
            );
    }
}