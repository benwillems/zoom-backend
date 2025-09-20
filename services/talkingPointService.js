// services/talkingPointService.js

const {
  PrismaClient,
  TalkingPointState,
  AppointmentStatus,
  ProgramStatus
} = require('@prisma/client');

const { generateTalkingPointsFromTemplate } = require('../utils/talkingPointsUtils');
const {
  NotFoundError,
  BadRequestError,
  ForbiddenError,
} = require('../errors/HttpError');

const prisma = new PrismaClient();

async function generateTalkingPoints({ appointmentId, authSub, templateId = null }) {
  // 0. Resolve coach (user)
  console.log("Generating talking points for appointmentId:", appointmentId);
  const user = await prisma.user.findFirst({
    where: { uniqueAuthId: authSub },
  });
  if (!user) throw new NotFoundError('User not found');

  // 1. Fetch appointment
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { client: true },
  });
  if (!appointment) throw new NotFoundError('Appointment not found');

  

  // 2. Idempotency check
  if (appointment.talkingPointState === TalkingPointState.GENERATING)
    throw new BadRequestError('Talking‑points generation already in progress');
  
  // Only return existing talking points if no specific template was requested
  // If a templateId is provided, we should regenerate with that template
  if (appointment.talkingPointState === TalkingPointState.GENERATED && 
      appointment.talkingPoints && 
      !templateId) {
    return appointment.talkingPoints;
  }

  await prisma.appointment.update({
    where: { id: appointmentId },
    data: { talkingPointState: TalkingPointState.GENERATING },
  });

  try {
    // 3. Session / week number
    const previousAppointments = await prisma.appointment.findMany({
      where: {
        clientId: appointment.clientId,
        status: AppointmentStatus.SUCCEEDED,
        scheduleStartAt: { lt: appointment.scheduleStartAt },
      },
      orderBy: { date: 'asc' },
    })

    const sessionNumber = previousAppointments.length + 1

    

    // Find user's talking point template
    let template;
    
    if (templateId) {
      // Use specific template if provided
      template = await prisma.template.findFirst({
        where: { 
          id: templateId,
          userId: user.id, 
          type: 'talkingPoint' 
        },
        include: { defaultTemplate: true }
      });
      
      if (!template) {
        throw new NotFoundError(`Talking point template with ID ${templateId} not found`);
      }
    } else {
      // Use default behavior - find first talking point template
      template = await prisma.template.findFirst({
        where: { userId: user.id, type: 'talkingPoint' },
        include: { defaultTemplate: true }
      });
      
      if (!template) {
        throw new NotFoundError('Talking point template not found');
      }
    }

    // Determine template ID to use
    const getTemplateId = () => {
      if (!template.order?.length) return template.id;
      
      const sessionTemplateId = template.order[sessionNumber - 1];
      if (sessionTemplateId && sessionTemplateId !== -1) return sessionTemplateId;
      
      // Find fallback (last non-(-1) value)
      return [...template.order].reverse().find(id => id !== -1) || template.id;
    };

    const resolvedTemplateId = getTemplateId();
    console.log("Template ID to use:", resolvedTemplateId);

    // Get the final template to use
    const templateToUse = resolvedTemplateId === template.id 
      ? template 
      : await prisma.template.findUnique({
          where: { id: resolvedTemplateId },
          include: { defaultTemplate: true }
        });

    if (!templateToUse) {
      throw new NotFoundError(`Template not found for session ${sessionNumber}`);
    }

    const staticTemplate = templateToUse.notesTemplate || template.defaultTemplate?.notesTemplate;

    // 4. Previous notes
    const lastNotes = previousAppointments
      .filter(a => a.notes) // only keep ones that have a notes field
      .map(a => {
        // 1) stringify the JSON (with 2-space indent for readability)
        const notesText =
          typeof a.notes === 'string'
            ? a.notes
            : JSON.stringify(a.notes, null, 2)

        // 2) format the date as YYYY-MM-DD
        const date = a.scheduleStartAt.toISOString().split('T')[0]

        return `**${date}**\n${notesText}`
      })
      .join('\n\n')

    // 5. Resolve programId
    const activeProgram = await prisma.programToClient.findFirst({
      where: {
        clientId: appointment.clientId,
        ProgramStatus: ProgramStatus.ACTIVE,
      },
    })
    const programId = activeProgram?.programId ?? null

    // 6. Fetch contextText (custom → default)
    let contextText = null

    // 6a. Coach-specific context
    if (programId) {

      const customCtxProgram = await prisma.contextProgram.findFirst({
        where: {
          userId: user.id,
          programId,
          weekNumber: sessionNumber,
        },
        include: {
          context: true,
        },
      })

      if (customCtxProgram?.context?.contextText) {
        contextText = customCtxProgram.context.contextText
      }

      console.log(
        'Custom context text:',
        contextText,
        'for user:',
        user.id,
        'and programId:',
        programId,
        'appointmentId:',
        appointmentId
      )

      // 6b. Fallback to default org-level context
      if (!contextText) {
        const defaultCtxProgram = await prisma.defaultContextProgram.findFirst({
          where: {
            programId,
            weekNumber: sessionNumber,
            defaultContext: {
              organizationId: user.organizationId,
            },
          },
          include: {
            defaultContext: true,
          },
        })

        if (defaultCtxProgram?.defaultContext?.contextText) {
          contextText = defaultCtxProgram.defaultContext.contextText
        }
      }
    }

    // // 7. Fetch static guide template
    // const template = await prisma.template.findFirst({
    //   where: { userId: user.id, type: 'talkingPoint' },
    //   include: { defaultTemplate: true },
    // })

    // if (!template) {
    //   throw new NotFoundError('Talking point template not found')
    // }

    // let staticTemplate

    // if (
    //   template.notesTemplate &&
    //   Object.keys(template.notesTemplate).length > 0
    // ) {
    //   staticTemplate = template.notesTemplate
    // } else if (template.defaultTemplate?.notesTemplate) {
    //   staticTemplate = template.defaultTemplate.notesTemplate
    // } else {
    //   throw new NotFoundError('Talking point template not found')
    // }

    // console.log("------session no. or week number------ : ",sessionNumber,"\n","------Static Template------ : ",staticTemplate, "\n------last notes------ : ",lastNotes,"\n------context text----- : ",contextText);

    // 8. Generate talking points
    const talkingPoints = await generateTalkingPointsFromTemplate(
      staticTemplate,
      lastNotes,
      contextText
    )

    // 9. Persist & return
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        talkingPoints,
        talkingPointState: TalkingPointState.GENERATED,
      },
    })

    return talkingPoints
  } catch (err) {
    // Rollback on failure
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { talkingPointState: TalkingPointState.PENDING },
    });
    throw err;
  }
}

async function getTalkingPointTemplates({ authSub }) {
  // Find the user
  const user = await prisma.user.findFirst({
    where: { uniqueAuthId: authSub },
  });
  if (!user) throw new NotFoundError('User not found');

  // Get all talking point templates for this user
  const templates = await prisma.template.findMany({
    where: { 
      userId: user.id, 
      type: 'talkingPoint' 
    },
    select: {
      id: true,
      name: true,
      type: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: {
      name: 'asc'
    }
  });

  return templates;
}

module.exports = { 
  generateTalkingPoints,
  getTalkingPointTemplates 
};