const { ChatClient } = require('@twurple/chat');
const { StaticAuthProvider } = require('@twurple/auth');
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Client, GatewayIntentBits } = require('discord.js');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

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

debug('Twitch Config:', { twitchClientId, twitchAccessToken, twitchChannel });

const authProvider = new StaticAuthProvider(twitchClientId, twitchAccessToken);
debug('AuthProvider created:', authProvider);

let chatClient;

try {
    chatClient = new ChatClient({ authProvider, channels: [twitchChannel] });
    debug('ChatClient created:', chatClient);
} catch (error) {
    debug('Error creating ChatClient:', error);
}

let cheerQueue = [];
let ttsClients = []; // Array to hold SSE clients for TTS

if (chatClient) {
    chatClient.onMessage((channel, user, message, msg) => {
        debug('Received message:', { channel, user, message, msg });
        if (msg.isCheer) {
            cheerQueue.push({ user: user.displayName, message, bits: msg.bits });
            debug('Cheer added to queue:', { user: user.displayName, message, bits: msg.bits });
        }
    });

    (async () => {
        try {
            await chatClient.connect();
            debug('Connected to Twitch chat');
        } catch (error) {
            debug('Error connecting to Twitch chat:', error);
        }
    })();
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from public directory

const discordToken = process.env.DISCORD_TOKEN;
const discordChannelId = process.env.DISCORD_CHANNEL_ID;

debug('Discord Config:', { discordToken, discordChannelId });

// Function to get the current stream information
async function getStreamInfo() {
    const response = await axios.get(`https://api.twitch.tv/helix/streams?user_login=${twitchChannel}`, {
        headers: {
            'Client-ID': twitchClientId,
            'Authorization': `Bearer ${twitchAccessToken}`
        }
    });
    const streamData = response.data.data[0];
    return streamData;
}

// Function to get the VOD information
async function getVodInfo(userId) {
    const response = await axios.get(`https://api.twitch.tv/helix/videos?user_id=${userId}&type=archive`, {
        headers: {
            'Client-ID': twitchClientId,
            'Authorization': `Bearer ${twitchAccessToken}`
        }
    });
    const vodData = response.data.data[0];
    return vodData;
}

// Function to get TTS audio from Eleven Labs
async function getTtsAudio(text) {
    const response = await axios.post('https://api.elevenlabs.io/v1/text-to-speech', {
        text: text,
        voice: 'your-voice-id' // Replace with your desired voice ID
    }, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${elevenLabsApiKey}`
        },
        responseType: 'arraybuffer'
    });

    return response.data;
}

// Function to notify SSE clients
function notifyTtsClients(audioUrl, message) {
    ttsClients.forEach(client => {
        client.write(`data: ${JSON.stringify({ audioUrl, message })}\n\n`);
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
            // Get the current stream information
            const streamInfo = await getStreamInfo();
            if (!streamInfo) {
                throw new Error('No active stream found');
            }

            const streamStartTime = new Date(streamInfo.started_at);
            const currentTime = new Date();
            const elapsedTime = Math.floor((currentTime - streamStartTime) / 1000); // elapsed time in seconds

            const minutes = Math.floor(elapsedTime / 60);
            const seconds = elapsedTime % 60;

            // Get the VOD information
            const vodInfo = await getVodInfo(streamInfo.user_id);
            const vodId = vodInfo.id;

            const timestamp = `${minutes}m${seconds}s`;
            const url = `https://www.twitch.tv/${twitchChannel}/v/${vodId}?t=${timestamp}`;

            const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
            await discordClient.login(discordToken);
            const channel = await discordClient.channels.fetch(discordChannelId);
            await channel.send(`Cheer from ${cheer.user}: ${cheer.message}\n${url}`);
            debug('Message sent to Discord:', { user: cheer.user, message: cheer.message, url });

            // Get TTS audio from Eleven Labs
            const ttsAudio = await getTtsAudio(`Cheer from ${cheer.user}: ${cheer.message}`);
            const audioFilePath = path.join(__dirname, 'public', 'cheer.mp3');
            fs.writeFileSync(audioFilePath, ttsAudio);

            // Notify SSE clients to play the audio
            notifyTtsClients('/cheer.mp3', `Cheer from ${cheer.user}: ${cheer.message}`);

            debug('TTS audio prepared and notification sent');

            res.json({ success: true, cheer, url });
        } catch (error) {
            debug('Error processing cheer:', error);
            res.status(500).json({ success: false, message: 'Failed to process cheer', error });
        }
    } else {
        debug('No cheers in queue');
        res.status(404).json({ success: false, message: 'No cheers in queue' });
    }
});

// Handle DELETE request to remove a cheer without processing
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

// Add a test route to simulate a cheer
app.post('/test-cheer', (req, res) => {
    debug('POST /test-cheer');
    const cheer = {
        user: 'testuser',
        message: 'This is a test cheer!',
        bits: 100
    };
    cheerQueue.push(cheer);
    debug('Test cheer added to queue:', cheer);
    res.json({ success: true, cheer });
});

// Serve the obs.html page
app.get('/obs', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'obs.html'));
});

// SSE endpoint for TTS notifications
app.get('/tts-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    ttsClients.push(res);

    req.on('close', () => {
        ttsClients = ttsClients.filter(client => client !== res);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    debug(`Server is running on port ${PORT}`);
});

