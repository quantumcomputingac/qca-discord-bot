import type * as TDiscord from 'discord.js'
import {
  isMemberUnconfirmed,
  getMemberWelcomeChannel,
  getWelcomeChannels,
  getMemberIdFromChannel,
  getSend,
  botLog,
  colors,
  getMemberLink,
} from './utils'
import {deleteWelcomeChannel} from './delete-welcome-channel'
import {handleNewMessage} from './handle-new-message'

async function cleanup(guild: TDiscord.Guild) {
  const welcomeChannels = getWelcomeChannels(guild)
  // the more channels we have running, the shorter the waiting time should be
  // because we can only have 50 channels in the welcome category
  // and two of those are already spoken for...
  const minMinutes = 3
  const maxMinutes = 20
  const maxChannelsAlteration =
    (welcomeChannels.size / 48) * (maxMinutes - minMinutes)
  const maxWaitingTime = 1000 * 60 * maxMinutes - maxChannelsAlteration

  // prime the cache
  await guild.members.fetch()

  const homelessUnconfirmedMembersKicks = guild.members.cache
    // they're not confirmed
    .filter(isMemberUnconfirmed)
    // they joined over 10 minutes ago
    .filter(
      ({joinedAt}) =>
        !joinedAt || joinedAt.getTime() < Date.now() - 1000 * 60 * 10,
    )
    // they don't have a welcome channel
    .filter(member => !getMemberWelcomeChannel(member))
    // map them to a promise to kick them
    .mapValues(member => {
      void botLog(guild, () => {
        return {
          title: '✌️ Kicking member',
          author: {
            name: member.displayName,
            iconURL: member.user.avatarURL() ?? member.user.defaultAvatarURL,
            url: getMemberLink(member),
          },
          color: colors.base0F,
          description: `${member} is unconfirmed and has no welcome channel.`,
          fields: [
            {
              name: 'Cause',
              value: `This can happen if onboading times out and channel is deleted but there's an error is kicking the member.`,
            },
          ],
        }
      })
      return member.kick(`Old unconfirmed member with no welcome channel`)
    })
    .values()

  const channelDeletes = welcomeChannels
    .mapValues(channel => cleanupChannel(guild, channel, maxWaitingTime))
    .values()

  const promises: Array<Promise<unknown>> = [
    ...channelDeletes,
    ...homelessUnconfirmedMembersKicks,
  ]
  await Promise.all(promises)
}

async function cleanupChannel(
  guild: TDiscord.Guild,
  channel: TDiscord.TextChannel,
  maxWaitingTime: number,
) {
  const tooManyMessages = 100
  const timeoutWarningMessageContent = `it's been a while and I haven't heard from you. This channel will get automatically deleted and you'll be removed from the server after a while. Don't worry though, you can always try again later when you have time to finish: https://kcd.im/discord`
  const spamWarningMessageContent = `you're sending a lot of messages, this channel will get deleted automatically if you send too many.`

  const send = getSend(channel)
  // load all the messages so we can get the last message
  await Promise.all([
    channel.messages.fetch().catch(i => i),
    channel.fetch().catch(i => i),
  ])

  const {lastMessage} = channel

  const memberId = getMemberIdFromChannel(channel)
  const member = guild.members.cache.find(({user}) => user.id === memberId)
  const mostRecentMemberMessage = channel.messages.cache
    .filter(({author}) => author.id === memberId)
    .sort((msgA, msgB) => (msgA.createdAt > msgB.createdAt ? -1 : 1))
    .first()

  const lastMemberInteractionTime = (
    mostRecentMemberMessage?.createdAt ?? channel.createdAt
  ).getTime()

  // somehow the member is gone (maybe they left the server?)
  // delete the channel
  if (!member || !lastMessage) {
    await deleteWelcomeChannel(
      channel,
      'Member is not in the server anymore. May have left the server.',
    )
    return
  }

  // if they're getting close to too many messages, give them a warning
  if (channel.messages.cache.size > tooManyMessages * 0.5) {
    const hasWarned = channel.messages.cache.find(({content}) =>
      content.includes(spamWarningMessageContent),
    )
    if (!hasWarned) {
      await send(`Whoa ${member.user}, ${spamWarningMessageContent}`)
    }
  }

  if (channel.messages.cache.size > tooManyMessages) {
    // they sent way too many messages... Spam probably...
    return deleteWelcomeChannel(channel, 'Too many messages')
  }

  const now = Date.now()

  if (lastMessage.author.id === member.id) {
    // they sent us something and we haven't responded yet
    // this happens if the bot goes down for some reason (normally when we redeploy)
    const timeSinceLastMessage = now - lastMemberInteractionTime
    if (timeSinceLastMessage > 2 * 1000) {
      // if it's been a while and we haven't handled the last message
      // then let's handle it now.
      await handleNewMessage(lastMessage)
    }
  } else {
    // we haven't heard from them in a while...
    const timeSinceLastMessage = now - lastMemberInteractionTime
    const hasBeenWarned = lastMessage.content.includes(
      timeoutWarningMessageContent,
    )
    const confirmed = !isMemberUnconfirmed(member)
    if (
      timeSinceLastMessage > maxWaitingTime &&
      ((!confirmed && hasBeenWarned) || confirmed)
    ) {
      return deleteWelcomeChannel(channel, 'Onboarding timed out')
    } else if (
      timeSinceLastMessage > maxWaitingTime * 0.7 &&
      !hasBeenWarned &&
      !confirmed
    ) {
      return send(`Hi ${member.user}, ${timeoutWarningMessageContent}`)
    } else if (timeSinceLastMessage > maxWaitingTime * 10) {
      // somehow this channel has stuck around for a long time
      // not sure how this should be possible, but we should delete it
      return deleteWelcomeChannel(channel, 'Onboarding timed out')
    }
  }
}

export {cleanup}
