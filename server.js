const { ChatClient } = require('@twurple/chat');
const { StaticAuthProvider } = require('@twurple/auth');
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Client, GatewayIntentBits } = require('discord.js');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

// Debug function
function debug(message, data = null) {
    console.log(`[DEBUG] ${message}`);
    if (data) {
        console.log(data);
    }
}

// Twitch configuration from environment variables
const twitchClientId = process.env.TWITCH_CLIENT_ID;
const twitchAccessToken = process.env.TWITCH_ACCESS_TOKEN;
const twitchChannel = process.env.TWITCH_CHANNEL;
const elevenLabsApiKey = process.env.ELEVEN_LABS_API_KEY;
const discordToken = process.env.DISCORD_TOKEN;
const discordChannelId = process.env.DISCORD_CHANNEL_ID;

debug('Twitch Config:', { twitchClientId, twitchAccessToken, twitchChannel });
debug('Discord Config:', { discordToken, discordChannelId });

const authProvider = new StaticAuthProvider(twitchClientId, twitchAccessToken);
debug('AuthProvider created:', authProvider);

let chatClient;
let cheerQueue = [];
let ttsClients = []; // Array to hold SSE clients for TTS

try {
    chatClient = new ChatClient({ authProvider, channels: [twitchChannel] });
    debug('ChatClient created:', chatClient);

    chatClient.onMessage((channel, user, message, msg) => {
        debug('Received message:', { channel, user, message, msg });
        if (msg.isCheer) {
            const charLimit = getCharacterLimit(msg.bits);
            const truncatedMessage = truncateMessage(message, charLimit);
            cheerQueue.push({ user: user.displayName, message: truncatedMessage, bits: msg.bits });
            debug('Cheer added to queue:', { user: user.displayName, message: truncatedMessage, bits: msg.bits });
        }
    });

    chatClient.connect().then(() => {
        debug('Connected to Twitch chat');
    }).catch((error) => {
        debug('Error connecting to Twitch chat:', error);
    });
} catch (error) {
    debug('Error creating ChatClient:', error);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/audio', express.static(path.join(__dirname, 'public')));

// Function to get the current stream information
async function getStreamInfo() {
    const response = await axios.get(`https://api.twitch.tv/helix/streams?user_login=${twitchChannel}`, {
        headers: {
            'Client-ID': twitchClientId,
            'Authorization': `Bearer ${twitchAccessToken}`
        }
    });
    return response.data.data[0];
}

// Characrter Limit check
function getCharacterLimit(bits) {
    if (bits <= 100) {
        return 100;
    } else if (bits <= 1000) {
        return 250;
    } else {
        return 500;
    }
}

// Message exceeds character limit 
function truncateMessage(message, limit) {
    if (message.length <= limit) {
        return message;
    }
    return message.slice(0, limit - 3) + '...';
}


// Function to get the VOD information
async function getVodInfo(userId) {
    const response = await axios.get(`https://api.twitch.tv/helix/videos?user_id=${userId}&type=archive`, {
        headers: {
            'Client-ID': twitchClientId,
            'Authorization': `Bearer ${twitchAccessToken}`
        }
    });
    return response.data.data[0];
}

// Function to get TTS audio from Eleven Labs
async function getTtsAudio(text) {
    try {
        console.log('Sending TTS request to ElevenLabs:', text);
        const response = await axios.post('https://api.elevenlabs.io/v1/text-to-speech/iP95p4xoKVk53GoZ742B', {
            text: text,
            model_id: "eleven_monolingual_v1",
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.5
            }
        }, {
            headers: {
                'Content-Type': 'application/json',
                'xi-api-key': elevenLabsApiKey
            },
            responseType: 'arraybuffer'
        });
        console.log('Received TTS response from ElevenLabs, size:', response.data.byteLength);
        return response.data;
    } catch (error) {
        console.error('Error in getTtsAudio:', error.response ? error.response.data : error.message);
        throw error;
    }
}

// Function to notify SSE clients
function notifyTtsClients(audioUrl, message) {
    console.log(`Notifying ${ttsClients.length} SSE clients:`, { audioUrl, message });
    ttsClients.forEach(client => {
        client.res.write(`data: ${JSON.stringify({ audioUrl, message })}\n\n`);
    });
}

app.get('/queue', (req, res) => {
    debug('GET /queue');
    res.json(cheerQueue);
});

app.post('/process', async (req, res) => {
    debug('POST /process');
    const cheer = cheerQueue.shift();
    if (cheer) {
        debug('Processing cheer:', cheer);

        try {
            let streamInfo, vodInfo, url;

            try {
                streamInfo = await getStreamInfo();
                if (!streamInfo) {
                    throw new Error('No active stream found');
                }

                const streamStartTime = new Date(streamInfo.started_at);
                const currentTime = new Date();
                const elapsedTime = Math.floor((currentTime - streamStartTime) / 1000);

                const minutes = Math.floor(elapsedTime / 60);
                const seconds = elapsedTime % 60;

                vodInfo = await getVodInfo(streamInfo.user_id);
                const vodId = vodInfo.id;

                const timestamp = `${minutes}m${seconds}s`;
                url = `https://www.twitch.tv/${twitchChannel}/v/${vodId}?t=${timestamp}`;

                const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
                await discordClient.login(discordToken);
                const channel = await discordClient.channels.fetch(discordChannelId);
                await channel.send(`Cheer from ${cheer.user}: ${cheer.message}\n${url}`);
                debug('Message sent to Discord:', { user: cheer.user, message: cheer.message, url });
            } catch (streamError) {
                debug('Error getting stream info or sending to Discord:', streamError);
            }

            const ttsAudio = await getTtsAudio(`Cheer from ${cheer.user}: ${cheer.message}`);
            
            const uniqueId = crypto.randomBytes(8).toString('hex');
            const audioFileName = `cheer_${uniqueId}.mp3`;
            const audioFilePath = path.join(__dirname, 'public', audioFileName);
            
            await fs.writeFile(audioFilePath, ttsAudio);
            console.log(`TTS audio file written to ${audioFilePath}`);
        
            notifyTtsClients(`/audio/${audioFileName}`, `Cheer from ${cheer.user}: ${cheer.message}`);
        
            debug('TTS audio prepared and notification sent');
        
            setTimeout(async () => {
                try {
                    await fs.unlink(audioFilePath);
                    console.log(`Deleted file: ${audioFilePath}`);
                } catch (err) {
                    console.error(`Error deleting file ${audioFilePath}:`, err);
                }
            }, 60000);

            res.json({ success: true, cheer, url: url || null });
        } catch (error) {
            debug('Error processing cheer:', error);
            res.status(500).json({ success: false, message: 'Failed to process cheer', error: error.message });
        }
    } else {
        debug('No cheers in queue');
        res.status(404).json({ success: false, message: 'No cheers in queue' });
    }
});

app.delete('/queue', (req, res) => {
    debug('DELETE /queue');
    const { index } = req.body;
    if (index >= 0 && index < cheerQueue.length) {
        cheerQueue.splice(index, 1);
        debug('Removed cheer at index:', index);
        res.json({ success: true });
    } else {
        debug('Invalid index:', index);
        res.status(400).json({ success: false, message: 'Invalid index' });
    }
});

app.post('/test-cheer', (req, res) => {
    debug('POST /test-cheer');
    const { user, message, bits } = req.body;
    const charLimit = getCharacterLimit(bits || 100);
    const truncatedMessage = truncateMessage(message || 'This is a test cheer!', charLimit);
    const cheer = {
        user: user || 'testuser',
        message: truncatedMessage,
        bits: bits || 100
    };
    cheerQueue.push(cheer);
    debug('Test cheer added to queue:', cheer);
    res.json({ success: true, cheer });
});

app.get('/obs', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'obs.html'));
});

app.get('/tts-stream', (req, res) => {
    console.log('New SSE connection established');
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    res.flushHeaders();

    const clientId = Date.now();
    const newClient = {
        id: clientId,
        res: res
    };
    ttsClients.push(newClient);

    req.on('close', () => {
        console.log(`SSE connection closed: ${clientId}`);
        ttsClients = ttsClients.filter(client => client.id !== clientId);
    });
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    debug(`Server is running on port ${PORT}`);
});