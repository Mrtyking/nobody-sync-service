import * as Discord from 'discord.js';
import { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, EmbedBuilder, MessageFlags } from 'discord.js';

/**
 * Capa de render con dos salidas para la misma "vista":
 *
 *  1. Components V2 (ContainerBuilder): el botón vive DENTRO del recuadro,
 *     como accesorio de una sección. Es lo que da el aspecto de panel premium.
 *  2. Embed clásico: fallback automático si la versión de discord.js instalada
 *     o el gateway rechazan Components V2.
 */

const V2_AVAILABLE =
  typeof Discord.ContainerBuilder === 'function' &&
  typeof Discord.SectionBuilder === 'function' &&
  typeof Discord.TextDisplayBuilder === 'function';

function makeButton(spec) {
  const button = new ButtonBuilder()
    .setLabel(spec.label)
    .setStyle(spec.style ?? Discord.ButtonStyle.Secondary);
  if (spec.url) button.setURL(spec.url).setStyle(Discord.ButtonStyle.Link);
  else button.setCustomId(spec.id);
  if (spec.disabled) button.setDisabled(true);
  return button;
}

function attachmentsOf(view) {
  return [view.banner, view.image]
    .filter(Boolean)
    .map((media) => new AttachmentBuilder(media.buffer, { name: media.name }));
}

function gallery(media) {
  return new Discord.MediaGalleryBuilder().addItems(
    new Discord.MediaGalleryItemBuilder().setURL(`attachment://${media.name}`),
  );
}

function separator(large = false) {
  const sep = new Discord.SeparatorBuilder();
  if (typeof sep.setSpacing === 'function') {
    sep.setSpacing(
      large ? Discord.SeparatorSpacingSize.Large : Discord.SeparatorSpacingSize.Small,
    );
  }
  return sep;
}

function text(content) {
  return new Discord.TextDisplayBuilder().setContent(content);
}

function attachAccessory(section, button) {
  // El nombre del método cambió entre versiones de discord.js.
  if (typeof section.setButtonAccessory === 'function') section.setButtonAccessory(button);
  else section.setAccessory(button);
  return section;
}

function buildV2(view) {
  const container = new Discord.ContainerBuilder();
  if (view.color != null) container.setAccentColor(view.color);

  const canRenderMedia = typeof Discord.MediaGalleryBuilder === 'function';
  // La cabecera va arriba del todo, antes del título.
  if (view.banner && canRenderMedia) container.addMediaGalleryComponents(gallery(view.banner));

  const head = [];
  if (view.title) head.push(`## ${view.title}`);
  if (view.subtitle) head.push(`-# ${view.subtitle}`);
  if (view.body) head.push(view.body);
  if (head.length) container.addTextDisplayComponents(text(head.join('\n')));

  if (view.image && canRenderMedia) {
    container.addSeparatorComponents(separator());
    container.addMediaGalleryComponents(gallery(view.image));
  }

  for (const block of view.blocks ?? []) {
    container.addSeparatorComponents(separator());
    if (block.button) {
      container.addSectionComponents(
        attachAccessory(
          new Discord.SectionBuilder().addTextDisplayComponents(text(block.text)),
          makeButton(block.button),
        ),
      );
    } else {
      container.addTextDisplayComponents(text(block.text));
    }
  }

  if (view.actions?.length) {
    container.addSeparatorComponents(separator());
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(view.actions.slice(0, 5).map(makeButton)),
    );
  }

  if (view.footer) {
    container.addSeparatorComponents(separator());
    container.addTextDisplayComponents(text(`-# ${view.footer}`));
  }

  return {
    components: [container],
    files: attachmentsOf(view),
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

function buildClassic(view) {
  const embed = new EmbedBuilder();
  if (view.color != null) embed.setColor(view.color);
  if (view.title) embed.setTitle(view.title);

  const description = [view.subtitle ? `-# ${view.subtitle}` : null, view.body]
    .filter(Boolean)
    .join('\n');
  if (description) embed.setDescription(description);

  for (const block of view.blocks ?? []) {
    const [first, ...rest] = block.text.split('\n');
    embed.addFields({
      name: first.replace(/\*\*/g, '').trim() || '​',
      value: rest.join('\n').replace(/^-# /gm, '') || '​',
    });
  }

  // Un embed clásico solo admite una imagen grande y una miniatura.
  if (view.image) {
    if (view.banner) embed.setThumbnail(`attachment://${view.banner.name}`);
    embed.setImage(`attachment://${view.image.name}`);
  } else if (view.banner) {
    embed.setImage(`attachment://${view.banner.name}`);
  }
  if (view.footer) embed.setFooter({ text: view.footer });

  const buttons = [
    ...(view.blocks ?? []).filter((b) => b.button).map((b) => b.button),
    ...(view.actions ?? []),
  ];
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5).map(makeButton)));
  }

  return {
    embeds: [embed],
    components: rows,
    files: attachmentsOf(view),
    allowedMentions: { parse: [] },
  };
}

function finalize(payload, view, method) {
  const result = { ...payload };
  // Al editar hay que descartar los adjuntos anteriores o el QR viejo se queda pegado.
  if (['editReply', 'update', 'edit'].includes(method)) result.attachments = [];
  // editReply/update heredan la visibilidad del mensaje original.
  if (view.ephemeral && ['reply', 'followUp', 'send'].includes(method)) {
    result.flags = (result.flags ?? 0) | MessageFlags.Ephemeral;
  }
  return result;
}

/**
 * Envía la vista intentando Components V2 y degradando a embed si falla.
 * `target` puede ser una interacción o un canal; `method` el método a usar.
 */
export async function deliver(target, method, view) {
  if (V2_AVAILABLE) {
    try {
      return await target[method](finalize(buildV2(view), view, method));
    } catch (error) {
      const code = error?.code ?? error?.rawError?.code;
      // 50035 = Invalid Form Body -> la versión del gateway no acepta V2 aquí.
      if (code !== 50035 && !/component/i.test(String(error?.message))) throw error;
    }
  }
  return target[method](finalize(buildClassic(view), view, method));
}

export const componentsV2Available = V2_AVAILABLE;
