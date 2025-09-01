const {
  reminderStatus,
  AppointmentFrequency,
  ProgramStatus,
  AppointmentStatus,
  PrismaClient
} = require('@prisma/client')
const prisma = new PrismaClient()
const { sendSms } = require('./phoneUtils')

// Helper function to convert frequency enum to days
const getFrequencyInDays = (frequency) => {
  const frequencyMap = {
    [AppointmentFrequency.WEEKLY]: 7,
    [AppointmentFrequency.HALF_MONTHLY]: 15,
    [AppointmentFrequency.MONTHLY]: 30
  };
  return frequencyMap[frequency] || 15; // Default to 15 days
};

// Helper function to calculate days passed
const getDaysPassed = (fromDate) => 
  Math.floor((Date.now() - fromDate.getTime()) / (24 * 60 * 60 * 1000));

// Helper function to check if threshold is reached
const isThresholdReached = (daysPassed, frequency, threshold = 0.5) => 
  1 - (daysPassed / frequency) < threshold;

const scheduleAppointmentReminders = async () => {
  console.log('Starting scheduleAppointmentReminders function');
  
  // Process active reminders
  await processActiveReminders();
  
  // Process active programs
  await processActivePrograms();
  
  // Process standalone clients
  const clients = await processStandaloneClients();
  
  console.log('Finished processing all clients');
  return clients;
};

const processActiveReminders = async () => {
  const reminders = await prisma.appointmentReminder.findMany({
    where: { status: reminderStatus.ACTIVE },
    include: { appointment: true, client: true, program: true }
  });

  console.log(`Found ${reminders.length} active reminders`);

  for (const reminder of reminders) {
    const frequency = getFrequencyInDays(
      reminder.client?.appointmentFrequency || reminder.program?.appointmentFrequency
    );

    const nextAppointment = await prisma.appointment.findFirst({
      where: {
        clientId: reminder.clientId,
        status: AppointmentStatus.SCHEDULED,
        scheduleStartAt: { gte: new Date() }
      }
    });

    if (nextAppointment) {
      await prisma.appointmentReminder.update({
        where: { id: reminder.id },
        data: {
          appointmentId: nextAppointment.id,
          status: reminderStatus.INACTIVE
        }
      });
    } else {
      const daysPassed = getDaysPassed(reminder.createdAt);
      if (isThresholdReached(daysPassed, frequency, 0.25) && !reminder.manualReminder) {
        await prisma.appointmentReminder.update({
          where: { id: reminder.id },
          data: { manualReminder: true }
        });
      }
    }
  }
};

const processActivePrograms = async () => {
  const activePrograms = await prisma.programToClient.findMany({
    where: {
      ProgramStatus: ProgramStatus.ACTIVE,
      program: { active: true }
    },
    include: { program: true, client: true }
  });

  console.log(`Found ${activePrograms.length} active programs`);

  for (const currentProgram of activePrograms) {
    const frequency = getFrequencyInDays(
      currentProgram.client.appointmentFrequency || currentProgram.program.appointmentFrequency
    );
    
    const daysPassed = getDaysPassed(currentProgram.program.createdAt);
    
    if (isThresholdReached(daysPassed, frequency)) {
      const hasRecentAppointment = await prisma.appointment.findFirst({
        where: {
          clientId: currentProgram.clientId,
          status: { in: [AppointmentStatus.SUCCEEDED, AppointmentStatus.SUCCEEDED_MULTI] },
          scheduleStartAt: { gte: new Date(Date.now() - frequency * 24 * 60 * 60 * 1000) }
        }
      });

      if (!hasRecentAppointment) {
        const existingReminder = await prisma.appointmentReminder.findFirst({
          where: {
            clientId: currentProgram.clientId,
            programId: currentProgram.programId,
            status: reminderStatus.ACTIVE
          }
        });

        if (!existingReminder) {
          await createReminder(
            currentProgram.clientId,
            currentProgram.programId,
            currentProgram.client.phone,
            currentProgram.client.appointmentFrequency || currentProgram.program.appointmentFrequency
          );
        }
      }
    }
  }
};

const processStandaloneClients = async () => {
  const clients = await prisma.client.findMany({
    where: {
      active: true,
      lastAppointmentDate: { not: null },
      NOT: {
        ProgramToClient: { some: { ProgramStatus: ProgramStatus.ACTIVE } }
      },
      appointmentReminders: { none: { status: reminderStatus.ACTIVE } },
      Appointment: { none: { status: AppointmentStatus.SCHEDULED, scheduleStartAt: { gt: new Date() } } }
    }
  });

  console.log(`Found ${clients.length} standalone clients`);

  for (const client of clients) {
    const frequency = getFrequencyInDays(client.appointmentFrequency);
    const daysPassed = getDaysPassed(client.lastAppointmentDate);
    
    if (isThresholdReached(daysPassed, frequency)) {
      await createReminder(client.id, null, client.phone, client.appointmentFrequency);
    }
  }
  
  return clients;
};

const createReminder = async (clientId, programId, phoneNumber, appointmentFrequency) => {
  const reminderMessage = `Reminder: You don't have any appointment scheduled for the next ${appointmentFrequency || 'few'} days. Please schedule an appointment with your nutritionist.`;
  
  await sendSms(phoneNumber, reminderMessage);
  
  // Calculate tentative date and ensure it's not in the past
  const calculatedDate = new Date(Date.now() + getFrequencyInDays(appointmentFrequency) * 24 * 60 * 60 * 1000);
  const tentativeDate = calculatedDate > new Date() ? calculatedDate : new Date();
  
  await prisma.appointmentReminder.create({
    data: {
      clientId,
      programId,
      status: reminderStatus.ACTIVE,
      sendSms: true,
      smsDateTime: new Date(),
      tentativeAppointmentDate: tentativeDate
    }
  });
  
  console.log(`Reminder created for client ${clientId}`);
};

module.exports = {
  scheduleAppointmentReminders,
}
