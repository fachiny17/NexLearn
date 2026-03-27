import os
from dotenv import load_dotenv
from livetranscriber import LiveTranscriber

load_dotenv()
def transcribe_audio():
    def on_transcript(text: str):
        print(text)

    transcriber = LiveTranscriber(
        callback=on_transcript,
        model="nova-3-general",
        language="en-US",
        punctuate=True,
        smart_format=True
    )

    print("Speak into your microphone. Press Ctrl + C to stop")

    try:
        transcriber.run()
    except KeyboardInterrupt:
        print("\nTranscription stopped!")
        
if __name__ == "__main__":    
    transcribe_audio()
