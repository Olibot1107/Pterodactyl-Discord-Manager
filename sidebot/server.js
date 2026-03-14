console.log('Starting server side bot...');
const config = require("../settings");
const { Client } = require('discord.js-selfbot-v13');
const client = new Client();

client.on('ready', async () => {
  console.log(`${client.user.username} is ready!`);
  // in the sevrer 1472918618999226390 check for all bots with the role 1481732089714966771
  const guild = client.guilds.cache.get('1472918618999226390');
  if (!guild) return;

  // Ensure members are cached, then read the role's member collection.
  await guild.members.fetch();
  const role = guild.roles.cache.get('1481732089714966771');
  if (!role) return;

  role.members.forEach(member => {
    if (member.user.bot) {
      console.log(`Found ${member.user.username}`);
    }
  });
})

client.login(config.SIDE_TOKEN);
