// Set the workerSrc for PDF.js - this is required for it to work
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.11.338/pdf.worker.min.js`;

// Get references to all the HTML elements we need to interact with
const checkScoreBtn = document.getElementById('checkScoreBtn');
const jobDescriptionEl = document.getElementById('jobDescription');
const resumeFileEl = document.getElementById('resumeFile');
const fileNameEl = document.getElementById('fileName');
const resultsEl = document.getElementById('results');
const loaderEl = document.getElementById('loader');
const resultContentEl = document.getElementById('resultContent');
const errorBoxEl = document.getElementById('errorBox');
const errorMessageEl = document.getElementById('errorMessage');

// This variable will hold the text extracted from the resume file
let resumeText = ''; 

// Listen for when a user selects a file
resumeFileEl.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) {
        return; // Exit if no file is selected
    }

    fileNameEl.textContent = `Reading: ${file.name}...`;
    hideError(); // Clear any previous errors
    const reader = new FileReader();

    // This function runs after the file has been loaded into memory
    reader.onload = async (e) => {
        try {
            // Check if the file is a PDF
            if (file.type === "application/pdf") {
                const pdf = await pdfjsLib.getDocument({ data: e.target.result }).promise;
                let textContent = '';
                // Loop through each page of the PDF to extract text
                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const text = await page.getTextContent();
                    textContent += text.items.map(s => s.str).join(' ');
                }
                resumeText = textContent;
            // Check if the file is a DOCX
            } else if (file.name.endsWith('.docx')) {
                const result = await mammoth.extractRawText({ arrayBuffer: e.target.result });
                resumeText = result.value;
            } else {
                // If it's not a PDF or DOCX, show an error
                throw new Error("Unsupported file type. Please upload a PDF or DOCX.");
            }
            fileNameEl.textContent = `Successfully loaded: ${file.name}`;
        } catch (error) {
            console.error("Error reading file:", error);
            showError(error.message || "Could not read the uploaded file.");
            fileNameEl.textContent = '';
            resumeFileEl.value = ''; // Reset the file input field
        }
    };
    
    // Start reading the file as an ArrayBuffer
    reader.readAsArrayBuffer(file);
});

// Listen for when the "Check My Score" button is clicked
checkScoreBtn.addEventListener('click', async () => {
    const jobDescription = jobDescriptionEl.value.trim();

    // Make sure we have both a job description and resume text
    if (!jobDescription || !resumeText) {
        showError("Please paste a job description and upload your resume file.");
        return;
    }
    
    // Show the loading spinner and hide any previous results
    hideError();
    resultsEl.classList.remove('hidden');
    loaderEl.classList.remove('hidden');
    resultContentEl.classList.add('hidden');

    // Call the Gemini API to get the analysis
    try {
        await callGeminiAPI(jobDescription, resumeText);
    } catch (error) {
        console.error("Error during API call:", error);
        showError("Failed to get analysis. Please try again later.");
        loaderEl.classList.add('hidden');
    }
});

/**
 * Sends the job description and resume to the Gemini API for analysis.
 * @param {string} jobDesc The job description text.
 * @param {string} resumeContent The resume text.
 */
async function callGeminiAPI(jobDesc, resumeContent) {
    // IMPORTANT: You must add your own API key here!
    const apiKey = ""; // <--- PASTE YOUR GOOGLE AI API KEY HERE

    // Show an error if the API key is missing
    if (apiKey === "") {
        showError("API Key is missing. Please add your Google AI API key to script.js");
        loaderEl.classList.add('hidden');
        return;
    }

    // The prompt that tells the AI what to do
    const prompt = `
        Act as an expert Applicant Tracking System (ATS).
        Analyze the provided resume against the job description.
        Provide your analysis in a JSON format with the following structure:
        {
          "score": <a number between 0 and 100 representing the match percentage>,
          "matched_keywords": [<an array of important keywords found in both the resume and job description>],
          "missing_keywords": [<an array of important keywords from the job description that are missing from the resume>],
          "suggestions": "<a string containing specific, actionable advice on how to improve the resume to better match the job description>"
        }

        Here is the Job Description:
        ---
        ${jobDesc}
        ---

        Here is the Resume Content:
        ---
        ${resumeContent}
        ---
    `;

    const payload = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
            responseMimeType: "application/json",
        }
    };
    
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

    // Try to fetch the data, with retries for certain errors
    let response;
    let success = false;
    let delay = 1000; // Start with a 1-second delay
    for (let i = 0; i < 4; i++) { // Try up to 4 times
        try {
            response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (response.ok) {
                success = true;
                break; // Exit the loop on success
            } else if (response.status === 429 || response.status >= 500) {
                // If the server is busy or has an error, wait and try again
                console.warn(`Request failed with status ${response.status}. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Double the delay for the next retry
            } else {
                // For other errors (like a bad API key), don't retry
                throw new Error(`API request failed with status ${response.status}`);
            }
        } catch (error) {
           console.warn(`Fetch attempt ${i + 1} failed. Retrying in ${delay}ms...`);
           await new Promise(resolve => setTimeout(resolve, delay));
           delay *= 2;
        }
    }

    if (!success) {
        throw new Error("API request failed after multiple retries.");
    }
    
    const result = await response.json();

    // Process the successful API response
    if (result.candidates && result.candidates[0].content && result.candidates[0].content.parts[0]) {
        const jsonText = result.candidates[0].content.parts[0].text;
        try {
            const parsedJson = JSON.parse(jsonText);
            displayResults(parsedJson);
        } catch (e) {
            console.error("Error parsing JSON response:", e, "Raw text:", jsonText);
            showError("Could not parse the analysis from the AI. The format was unexpected.");
            loaderEl.classList.add('hidden');
        }
    } else {
        console.error("Unexpected API response structure:", result);
        showError("Received an unexpected response from the analysis service.");
        loaderEl.classList.add('hidden');
    }
}

/**
 * Displays the analysis results on the page.
 * @param {object} data The parsed JSON data from the API.
 */
function displayResults(data) {
    document.getElementById('score').textContent = `${data.score || 0}%`;
    
    const matchedKeywordsList = document.getElementById('matchedKeywords');
    matchedKeywordsList.innerHTML = ''; // Clear previous results
    if (data.matched_keywords && data.matched_keywords.length > 0) {
        data.matched_keywords.forEach(keyword => {
            const li = document.createElement('li');
            li.textContent = keyword;
            matchedKeywordsList.appendChild(li);
        });
    } else {
        matchedKeywordsList.innerHTML = '<li>No significant keywords matched.</li>';
    }

    const missingKeywordsList = document.getElementById('missingKeywords');
    missingKeywordsList.innerHTML = ''; // Clear previous results
     if (data.missing_keywords && data.missing_keywords.length > 0) {
        data.missing_keywords.forEach(keyword => {
            const li = document.createElement('li');
            li.textContent = keyword;
            missingKeywordsList.appendChild(li);
        });
    } else {
        missingKeywordsList.innerHTML = '<li>No significant keywords were found missing. Great job!</li>';
    }

    document.getElementById('suggestions').innerHTML = data.suggestions ? data.suggestions.replace(/\n/g, '<br>') : 'No suggestions provided.';

    // Hide the loader and show the results
    loaderEl.classList.add('hidden');
    resultContentEl.classList.remove('hidden');
}

/**
 * Shows an error message to the user.
 * @param {string} message The error message to display.
 */
function showError(message) {
    errorMessageEl.textContent = message;
    errorBoxEl.classList.remove('hidden');
}

/**
 * Hides the error message box.
 */
function hideError() {
    errorBoxEl.classList.add('hidden');
}
