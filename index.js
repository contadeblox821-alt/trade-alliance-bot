require('dotenv').config();
const { 
  Client, 
  GatewayIntentBits, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  PermissionFlagsBits,
  ChannelType
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// Configuração do Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Inicialização do Client do Discord
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// Funções Utilitárias para Geração do Pix EMV BR Code (Copia e Cola)
function formatEMV(id, value) {
  const len = value.length.toString().padStart(2, '0');
  return `${id}${len}${value}`;
}

function calculateCRC16(payload) {
  let polinomio = 0x1021;
  let resultado = 0xFFFF;

  for (let offset = 0; offset < payload.length; offset++) {
    resultado ^= (payload.charCodeAt(offset) << 8);
    for (let bitwise = 0; bitwise < 8; bitwise++) {
      if ((resultado <<= 1) & 0x10000) {
        resultado ^= polinomio;
      }
      resultado &= 0xFFFF;
    }
  }
  return resultado.toString(16).toUpperCase().padStart(4, '0');
}

function generatePixPayload(key, name, city, amount, txid) {
  // Limpeza de texto
  const cleanName = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").substring(0, 25);
  const cleanCity = city.normalize("NFD").replace(/[\u0300-\u036f]/g, "").substring(0, 15);
  const cleanTxid = txid.replace(/[^a-zA-Z0-9]/g, "").substring(0, 25);
  const formattedAmount = Number(amount).toFixed(2);

  const merchantAccount = 
    formatEMV('00', 'br.gov.bcb.pix') +
    formatEMV('01', key);

  const additionalData = formatEMV('05', cleanTxid || '***');

  let payload = 
    formatEMV('00', '01') +
    formatEMV('26', merchantAccount) +
    formatEMV('52', '0000') +
    formatEMV('53', '986') +
    formatEMV('54', formattedAmount) +
    formatEMV('58', 'BR') +
    formatEMV('59', cleanName) +
    formatEMV('60', cleanCity) +
    formatEMV('62', additionalData) +
    '6304';

  const crc = calculateCRC16(payload);
  return payload + crc;
}

// Registro dos Slash Commands
const commands = [
  new SlashCommandBuilder()
    .setName('comprar')
    .setDescription('Exibe o catálogo de produtos disponíveis para compra.'),

  new SlashCommandBuilder()
    .setName('pedidos')
    .setDescription('Gerencia os pedidos pendentes do servidor (Staff/ADM).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('dashboard')
    .setDescription('Exibe o relatório financeiro e resumo dos pedidos (Staff/ADM).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
];

// Instância do REST para registro de comandos
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function registerCommands() {
  try {
    console.log('Atualizando comandos Slash da aplicação...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Comandos Slash registrados com sucesso!');
  } catch (error) {
    console.error('Erro ao registrar comandos Slash:', error);
  }
}

client.once('ready', () => {
  console.log(`Bot online como ${client.user.tag}`);
  registerCommands();
});

// Evento de Comandos Slash e Interações
client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // --- COMANDO /COMPRAR ---
    if (commandName === 'comprar') {
      await interaction.deferReply({ ephemeral: true });

      const { data: products, error } = await supabase
        .from('products')
        .select('*')
        .order('id', { ascending: true });

      if (error || !products || products.length === 0) {
        return interaction.editReply({ content: 'Nenhum produto cadastrado no catálogo no momento.' });
      }

      let currentIndex = 0;

      const buildEmbed = (index) => {
        const prod = products[index];
        const embed = new EmbedBuilder()
          .setTitle(`🛒 Catálogo de Produtos (${index + 1}/${products.length})`)
          .setColor('#2b2d31')
          .addFields(
            { name: '📦 Nome', value: prod.name, inline: true },
            { name: '💵 Preço', value: `R$ ${Number(prod.price).toFixed(2)}`, inline: true },
            { name: '📝 Descrição', value: prod.description || 'Sem descrição informada.' }
          )
          .setFooter({ text: 'Use os botões abaixo para navegar e realizar a compra.' });

        if (prod.image_url) {
          embed.setImage(prod.image_url);
        }

        return embed;
      };

      const buildButtons = (index) => {
        return new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('prev_page')
            .setLabel('⬅️ Anterior')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(index === 0),
          new ButtonBuilder()
            .setCustomId(`buy_product_${products[index].id}`)
            .setLabel('💳 Comprar Produto')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('next_page')
            .setLabel('Próximo ➡️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(index === products.length - 1)
        );
      };

      const response = await interaction.editReply({
        embeds: [buildEmbed(currentIndex)],
        components: [buildButtons(currentIndex)]
      });

      const collector = response.createMessageComponentCollector({ time: 300000 }); // 5 min

      collector.on('collect', async (i) => {
        if (i.user.id !== interaction.user.id) {
          return i.reply({ content: 'Apenas a pessoa que abriu o catálogo pode navegar nele.', ephemeral: true });
        }

        if (i.customId === 'prev_page') {
          currentIndex--;
          await i.update({
            embeds: [buildEmbed(currentIndex)],
            components: [buildButtons(currentIndex)]
          });
        } else if (i.customId === 'next_page') {
          currentIndex++;
          await i.update({
            embeds: [buildEmbed(currentIndex)],
            components: [buildButtons(currentIndex)]
          });
        } else if (i.customId.startsWith('buy_product_')) {
          await i.deferUpdate();
          const productId = i.customId.replace('buy_product_', '');
          const selectedProduct = products.find(p => p.id == productId);

          // Criar Canal Privado de Ticket de Compra
          const guild = interaction.guild;
          const member = interaction.member;

          try {
            const channel = await guild.channels.create({
              name: `carrinho-${interaction.user.username}`,
              type: ChannelType.GuildText,
              parent: process.env.CATEGORY_TICKETS_ID || null,
              permissionOverwrites: [
                {
                  id: guild.id,
                  deny: [PermissionFlagsBits.ViewChannel]
                },
                {
                  id: member.id,
                  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                },
                {
                  id: process.env.STAFF_ROLE_ID,
                  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                }
              ]
            });

            // Registrar Pedido no Supabase
            const { data: order, error: orderError } = await supabase
              .from('orders')
              .insert({
                user_id: member.id,
                user_tag: member.user.tag,
                product_id: selectedProduct.id,
                product_name: selectedProduct.name,
                amount: selectedProduct.price,
                status: 'PENDING',
                channel_id: channel.id
              })
              .select()
              .single();

            if (orderError) throw orderError;

            // Gerar Código Pix EMV
            const txid = `USER${member.user.username.replace(/[^a-zA-Z0-9]/g, '')}`;
            const pixCode = generatePixPayload(
              process.env.PIX_KEY,
              process.env.PIX_NAME || 'Loja Discord',
              process.env.PIX_CITY || 'Brasil',
              selectedProduct.price,
              txid
            );

            const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(pixCode)}`;

            const ticketEmbed = new EmbedBuilder()
              .setTitle(`🧾 Detalhes do Pedido #${order.id}`)
              .setColor('#57f287')
              .setDescription(`Olá ${member}, seu canal de pagamento foi criado com sucesso!`)
              .addFields(
                { name: '📦 Produto', value: selectedProduct.name, inline: true },
                { name: '💵 Valor', value: `R$ ${Number(selectedProduct.price).toFixed(2)}`, inline: true },
                { name: '🔑 Identificador Pix (TXID)', value: `\`${txid}\`` },
                { name: '📌 Chave Pix Copia e Cola', value: `\`\`\`${pixCode}\`\`\`` }
              )
              .setImage(qrCodeUrl)
              .setFooter({ text: 'Após efetuar o pagamento, envie o comprovante neste canal.' });

            const ticketButtons = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`cancel_order_${order.id}`)
                .setLabel('Cancelar Pedido')
                .setStyle(ButtonStyle.Danger)
            );

            await channel.send({
              content: `${member} | <@&${process.env.STAFF_ROLE_ID}>`,
              embeds: [ticketEmbed],
              components: [ticketButtons]
            });

            await i.followUp({ content: `✅ Seu carrinho foi criado! Acesse: ${channel}`, ephemeral: true });

          } catch (err) {
            console.error('Erro ao criar canal de compra:', err);
            await i.followUp({ content: '❌ Houve um erro ao criar seu canal de compra.', ephemeral: true });
          }
        }
      });
    }

    // --- COMANDO /PEDIDOS ---
    if (commandName === 'pedidos') {
      if (!interaction.member.roles.cache.has(process.env.STAFF_ROLE_ID) && 
          !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Apenas membros da Staff podem acessar este comando.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const { data: pendingOrders, error } = await supabase
        .from('orders')
        .select('*')
        .eq('status', 'PENDING')
        .order('created_at', { ascending: false });

      if (error || !pendingOrders || pendingOrders.length === 0) {
        return interaction.editReply({ content: '✅ Não há pedidos pendentes no momento.' });
      }

      const embeds = [];
      const rows = [];

      for (const order of pendingOrders.slice(0, 5)) { // Exibe até 5 no painel
        const embed = new EmbedBuilder()
          .setTitle(`📦 Pedido #${order.id}`)
          .setColor('#f1c40f')
          .addFields(
            { name: '👤 Comprador', value: `<@${order.user_id}> (${order.user_tag})`, inline: true },
            { name: '🛒 Produto', value: order.product_name, inline: true },
            { name: '💰 Valor', value: `R$ ${Number(order.amount).toFixed(2)}`, inline: true },
            { name: '📅 Data', value: new Date(order.created_at).toLocaleString('pt-BR') }
          );

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`approve_order_${order.id}`)
            .setLabel('Aprovar Compra')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`deny_order_${order.id}`)
            .setLabel('Negar Compra')
            .setStyle(ButtonStyle.Danger)
        );

        embeds.push(embed);
        rows.push(row);
      }

      await interaction.editReply({
        content: `📋 **Lista de Pedidos Pendentes (${pendingOrders.length} no total):**`,
        embeds: embeds,
        components: rows
      });
    }

    // --- COMANDO /DASHBOARD ---
    if (commandName === 'dashboard') {
      if (!interaction.member.roles.cache.has(process.env.STAFF_ROLE_ID) && 
          !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Apenas a Staff/ADM pode ver a Dashboard.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const { data: orders, error } = await supabase
        .from('orders')
        .select('*');

      if (error || !orders) {
        return interaction.editReply({ content: '❌ Erro ao buscar os dados da dashboard.' });
      }

      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const last30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const approvedOrders = orders.filter(o => o.status === 'APPROVED');

      const calcStats = (startDate) => {
        const filtered = approvedOrders.filter(o => new Date(o.created_at) >= startDate);
        const count = filtered.length;
        const total = filtered.reduce((acc, curr) => acc + Number(curr.amount), 0);
        return { count, total };
      };

      const statsToday = calcStats(today);
      const stats7Days = calcStats(last7Days);
      const stats30Days = calcStats(last30Days);
      const statsTotal = {
        count: approvedOrders.length,
        total: approvedOrders.reduce((acc, curr) => acc + Number(curr.amount), 0)
      };

      const dashboardEmbed = new EmbedBuilder()
        .setTitle('📊 Dashboard Geral de Vendas')
        .setColor('#3498db')
        .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
        .addFields(
          { name: '📅 Hoje', value: `📦 **${statsToday.count}** pedidos\n💵 **R$ ${statsToday.total.toFixed(2)}**`, inline: true },
          { name: '🗓️ Últimos 7 Dias', value: `📦 **${stats7Days.count}** pedidos\n💵 **R$ ${stats7Days.total.toFixed(2)}**`, inline: true },
          { name: '📆 Últimos 30 Dias', value: `📦 **${stats30Days.count}** pedidos\n💵 **R$ ${stats30Days.total.toFixed(2)}**`, inline: true },
          { name: '🏆 Total Acumulado (Geral)', value: `📦 **${statsTotal.count}** pedidos aprovados\n💰 **R$ ${statsTotal.total.toFixed(2)}** em receita` }
        )
        .setFooter({ text: 'Atualizado em tempo real via Supabase.' })
        .setTimestamp();

      await interaction.editReply({ embeds: [dashboardEmbed] });
    }
  }

  // --- TRATAMENTO DE INTERAÇÕES DE BOTÕES DE APROVAÇÃO/NEGAÇÃO/CANCELAMENTO ---
  if (interaction.isButton()) {
    const { customId } = interaction;

    // Aprovar Compra
    if (customId.startsWith('approve_order_')) {
      const orderId = customId.replace('approve_order_', '');

      const { data: order, error } = await supabase
        .from('orders')
        .update({ status: 'APPROVED' })
        .eq('id', orderId)
        .select()
        .single();

      if (error || !order) {
        return interaction.reply({ content: '❌ Erro ao atualizar o pedido no banco de dados.', ephemeral: true });
      }

      await interaction.reply({ content: `✅ Pedido #${orderId} aprovado com sucesso!`, ephemeral: true });

      // Notificar o comprador
      try {
        const user = await client.users.fetch(order.user_id);
        if (user) {
          const clientEmbed = new EmbedBuilder()
            .setTitle('🎉 Pagamento Confirmado!')
            .setColor('#57f287')
            .setDescription(`Seu pedido do produto **${order.product_name}** foi aprovado com sucesso pela equipe! O produto/cargo será entregue em breve.`);
          
          await user.send({ embeds: [clientEmbed] });
        }
      } catch (err) {
        console.log('Não foi possível enviar mensagem privada ao usuário.');
      }

      // Deletar ou Fechar o Canal de Ticket se existir
      if (order.channel_id) {
        const channel = interaction.guild.channels.cache.get(order.channel_id);
        if (channel) {
          await channel.send('✅ Pagamento confirmado! Este canal será fechado em 10 segundos...');
          setTimeout(() => channel.delete().catch(() => {}), 10000);
        }
      }
    }

    // Negar Compra
    if (customId.startsWith('deny_order_')) {
      const orderId = customId.replace('deny_order_', '');

      const { data: order, error } = await supabase
        .from('orders')
        .update({ status: 'REJECTED' })
        .eq('id', orderId)
        .select()
        .single();

      if (error || !order) {
        return interaction.reply({ content: '❌ Erro ao atualizar o pedido no banco de dados.', ephemeral: true });
      }

      await interaction.reply({ content: `❌ Pedido #${orderId} foi recusado.`, ephemeral: true });

      // Notificar usuário e apagar canal
      if (order.channel_id) {
        const channel = interaction.guild.channels.cache.get(order.channel_id);
        if (channel) {
          await channel.send('❌ O pagamento foi negado ou cancelado pela Staff. Este canal será fechado em 10 segundos...');
          setTimeout(() => channel.delete().catch(() => {}), 10000);
        }
      }
    }

    // Cancelar Pedido pelo Comprador no Carrinho
    if (customId.startsWith('cancel_order_')) {
      const orderId = customId.replace('cancel_order_', '');

      await supabase
        .from('orders')
        .update({ status: 'REJECTED' })
        .eq('id', orderId);

      await interaction.reply('Pedido cancelado pelo cliente. Apagando canal...');
      setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
    }
  }
});

// Login do Bot
client.login(process.env.DISCORD_TOKEN);